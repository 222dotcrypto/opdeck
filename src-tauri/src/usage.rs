// RFC 0004 / PLAN 0004 Фаза A — каркас движка расходов (чтение локальных usage-логов агентов).
// Чистый слой данных: парсеры форматов 3 CLI → единый UsageRecord, дедуп, скан файла, маппинг
// сессии opdeck → файл агента по cwd. Стоимость ($), 5ч-окно, контекст-бейдж и UI — следующие
// фазы; здесь только надёжно достаём токены/контекст из РЕАЛЬНЫХ форматов (структуры сняты с
// живых логов на машине — см. RFC §«Reality-gate источников»).
//
// Форматы (verified 2026-06-15):
//   Claude — `~/.claude/projects/<cwd с '/'→'-'>/<uuid>.jsonl`, строки `type=assistant` с
//            `message.usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`.
//   Codex  — `~/.codex/sessions/**/rollout-*.jsonl`, строки `type=event_msg` +
//            `payload.type=token_count` → `payload.info.total_token_usage` (КУМУЛЯТИВ).
//   Grok   — `~/.grok/sessions/<urlenc(cwd)>/<uuid>/signals.json` (снимок сессии):
//            `contextTokensUsed`/`contextWindowTokens`/`contextWindowUsage`(%)/`primaryModelId`.

// Часть API (scan_*, latest_*_for_cwd) потребляется в Фазах B–E (стоимость/контекст/UI/пул) —
// в Фазе A это фундамент, поэтому глушим dead_code на уровне модуля.
#![allow(dead_code)]

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Vendor {
    Claude,
    Codex,
    Grok,
}

// Единая запись расхода/контекста. Поля, которых у источника нет, остаются None/0 — заполняются
// в следующих фазах (модель Codex — из meta; контекст Claude/Codex — производный; деньги Grok — позже).
#[derive(Debug, Clone, serde::Serialize)]
pub struct UsageRecord {
    pub vendor: Vendor,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub ts_iso: Option<String>, // сырой ISO-таймстемп; в epoch-ms конвертируем в Фазе B (5ч-окно)
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,             // Codex: кумулятивный total; Claude/Grok: сумма/контекст-прокси
    pub context_used: Option<u64>,     // Grok — прямой; Claude/Codex — прокси (вход+кэш-чтение)
    pub context_window: Option<u64>,   // Grok — прямой; др. — в Фазе C из таблицы окон моделей
    pub request_id: Option<String>,    // Claude — ключ дедупа
    pub message_id: Option<String>,    // Claude — ключ дедупа
}

// ── Claude ───────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
struct ClaudeLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<ClaudeMessage>,
}
#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}
#[derive(Deserialize, Default)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

// Распарсить одну строку Claude-транскрипта. Возвращает запись ТОЛЬКО для assistant-строк с usage
// (системные/user/служебные строки → None). Неизвестные поля serde игнорирует.
pub fn parse_claude_line(line: &str) -> Option<UsageRecord> {
    let l: ClaudeLine = serde_json::from_str(line.trim()).ok()?;
    if l.kind.as_deref() != Some("assistant") {
        return None;
    }
    let msg = l.message?;
    let u = msg.usage?; // нет usage → не считаем
    let context_used = u.input_tokens.saturating_add(u.cache_read_input_tokens);
    Some(UsageRecord {
        vendor: Vendor::Claude,
        session_id: l.session_id,
        cwd: l.cwd,
        model: msg.model,
        ts_iso: l.timestamp,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_tokens: u.cache_creation_input_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        total_tokens: u.input_tokens
            + u.output_tokens
            + u.cache_creation_input_tokens
            + u.cache_read_input_tokens,
        context_used: Some(context_used),
        context_window: None, // окно модели — в Фазе C
        request_id: l.request_id,
        message_id: msg.id,
    })
}

// ── Codex ────────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
struct CodexLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    payload: Option<CodexPayload>,
}
#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    info: Option<CodexInfo>,
}
#[derive(Deserialize)]
struct CodexInfo {
    total_token_usage: Option<CodexTokens>,
}
#[derive(Deserialize, Default)]
struct CodexTokens {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

// Распарсить одну строку Codex-rollout. Возвращает запись только для `token_count`-событий.
// ВАЖНО: `total_token_usage` — КУМУЛЯТИВНЫЙ снимок (растёт по ходу сессии); дельту между снимками
// считаем в Фазе B (cost), иначе кратный перерасчёт. Модель тут не лежит (в meta-строке) → None.
pub fn parse_codex_line(line: &str) -> Option<UsageRecord> {
    let l: CodexLine = serde_json::from_str(line.trim()).ok()?;
    if l.kind.as_deref() != Some("event_msg") {
        return None;
    }
    let p = l.payload?;
    if p.kind.as_deref() != Some("token_count") {
        return None;
    }
    let t = p.info?.total_token_usage?;
    Some(UsageRecord {
        vendor: Vendor::Codex,
        session_id: None,
        cwd: None,
        model: None,
        ts_iso: l.timestamp,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cache_creation_tokens: 0,
        cache_read_tokens: t.cached_input_tokens,
        total_tokens: t.total_tokens,
        context_used: Some(t.total_tokens), // прокси контекста; окно модели — в Фазе C
        context_window: None,
        request_id: None,
        message_id: None,
    })
}

// ── Grok ─────────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
struct GrokSignals {
    #[serde(rename = "contextTokensUsed")]
    context_tokens_used: Option<u64>,
    #[serde(rename = "contextWindowTokens")]
    context_window_tokens: Option<u64>,
    #[serde(rename = "primaryModelId")]
    primary_model_id: Option<String>,
}

// Распарсить `signals.json` Grok-сессии — это СНИМОК (одна запись на сессию, не поток сообщений).
// Даёт прямой размер контекста; токены для денег ($) лежат в updates.jsonl и в scope позже (OQ1).
pub fn parse_grok_signals(json: &str) -> Option<UsageRecord> {
    let s: GrokSignals = serde_json::from_str(json.trim()).ok()?;
    let used = s.context_tokens_used?;
    Some(UsageRecord {
        vendor: Vendor::Grok,
        session_id: None,
        cwd: None,
        model: s.primary_model_id,
        ts_iso: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: used,
        context_used: Some(used),
        context_window: s.context_window_tokens,
        request_id: None,
        message_id: None,
    })
}

// ── Дедуп (Claude) ─────────────────────────────────────────────────────────────
// Claude может писать одно и то же assistant-сообщение несколько раз (стриминг/повтор) — дедуп по
// паре (message_id, request_id), как в ccusage. Записи без обоих ключей не схлопываем.
pub fn dedup_claude(records: Vec<UsageRecord>) -> Vec<UsageRecord> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(records.len());
    for r in records {
        match (&r.message_id, &r.request_id) {
            (Some(m), Some(rq)) => {
                if seen.insert(format!("{m}\u{0}{rq}")) {
                    out.push(r);
                }
            }
            _ => out.push(r),
        }
    }
    out
}

// ── Скан файлов ────────────────────────────────────────────────────────────────
pub fn scan_claude_file(path: &Path) -> Vec<UsageRecord> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let recs: Vec<UsageRecord> = text.lines().filter_map(parse_claude_line).collect();
    dedup_claude(recs)
}

pub fn scan_codex_file(path: &Path) -> Vec<UsageRecord> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    text.lines().filter_map(parse_codex_line).collect()
}

pub fn scan_grok_session(session_dir: &Path) -> Option<UsageRecord> {
    let signals = session_dir.join("signals.json");
    let text = std::fs::read_to_string(signals).ok()?;
    parse_grok_signals(&text)
}

// ── Маппинг сессии opdeck → файл агента (фолбэк по cwd) ──────────────────────────
// Точный маппинг будет через SessionStart-хук (transcript_path + $DECK_SESSION_ID, приёмник
// RFC 0003) — это следующий слой. Здесь — детерминированный фолбэк по рабочей папке сессии.

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

// Claude кодирует cwd в имя папки проекта заменой '/' → '-' (вкл. ведущий слэш).
pub fn claude_project_dir(cwd: &str) -> PathBuf {
    home()
        .join(".claude")
        .join("projects")
        .join(cwd.replace('/', "-"))
}

// Grok кодирует cwd в имя папки URL-энкодом '/' → '%2F'.
pub fn grok_cwd_dir(cwd: &str) -> PathBuf {
    home()
        .join(".grok")
        .join("sessions")
        .join(cwd.replace('/', "%2F"))
}

// Новейший по mtime файл, удовлетворяющий предикату, в директории (нерекурсивно).
fn newest_in<F: Fn(&Path) -> bool>(dir: &Path, want: F) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if !want(&p) {
            continue;
        }
        let mt = entry.metadata().and_then(|m| m.modified()).ok()?;
        if best.as_ref().map_or(true, |(t, _)| mt > *t) {
            best = Some((mt, p));
        }
    }
    best.map(|(_, p)| p)
}

// Новейший Claude-транскрипт для рабочей папки (фолбэк-маппинг).
pub fn latest_claude_file_for_cwd(cwd: &str) -> Option<PathBuf> {
    newest_in(&claude_project_dir(cwd), |p| {
        p.extension().map_or(false, |e| e == "jsonl")
    })
}

// Новейшая Grok-сессия (подпапка-uuid) для рабочей папки (фолбэк-маппинг).
pub fn latest_grok_session_for_cwd(cwd: &str) -> Option<PathBuf> {
    newest_in(&grok_cwd_dir(cwd), |p| p.is_dir())
}

// ── Фаза B: стоимость + 5-часовое окно ──────────────────────────────────────────

// Цена модели, USD за 1M токенов. Источник Claude — справочник claude-api (cached 2026-06-04):
// Opus 5/25, Sonnet 3/15, Haiku 1/5, Fable 10/50. Кэш по правилам кэширования: запись-5м =
// input×1.25, запись-1ч = input×2, чтение = input×0.1. Codex/Grok пока None — их $ требует
// снапшота LiteLLM (RFC OUT v1, не зашиваем угаданные цены).
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

fn claude_price(input: f64, output: f64) -> ModelPrice {
    ModelPrice {
        input,
        output,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
        cache_read: input * 0.1,
    }
}

// Матч по id модели (claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5 / claude-fable-5…).
// Только Claude (codex=gpt-*, grok=grok-* не матчатся → None до LiteLLM-снапшота).
pub fn price_for_model(model: &str) -> Option<ModelPrice> {
    let m = model.to_ascii_lowercase();
    if !m.contains("claude") && !m.contains("opus") && !m.contains("sonnet")
        && !m.contains("haiku") && !m.contains("fable") && !m.contains("mythos")
    {
        return None;
    }
    Some(if m.contains("fable") || m.contains("mythos") {
        claude_price(10.0, 50.0)
    } else if m.contains("opus") {
        claude_price(5.0, 25.0)
    } else if m.contains("sonnet") {
        claude_price(3.0, 15.0)
    } else if m.contains("haiku") {
        claude_price(1.0, 5.0)
    } else {
        return None; // claude-* без узнаваемого тира — лучше None, чем неверная цена
    })
}

// Стоимость записи в USD (None если модели/цены нет). cache_creation считаем по записи-5м
// (дефолт; разбивка 5m/1h — уточнение позже, RFC §Риски).
pub fn cost_usd(r: &UsageRecord) -> Option<f64> {
    let p = price_for_model(r.model.as_deref()?)?;
    Some(
        (r.input_tokens as f64 * p.input
            + r.output_tokens as f64 * p.output
            + r.cache_creation_tokens as f64 * p.cache_write_5m
            + r.cache_read_tokens as f64 * p.cache_read)
            / 1_000_000.0,
    )
}

// ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS(.fff)?Z`) → epoch-ms. Без chrono-зависимости: фиксированный
// формат логов агентов. Доли секунды — до 3 знаков. Возвращает None на кривом вводе.
pub fn iso_to_epoch_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.trim().parse().ok() };
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, se) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let mut ms = 0i64;
    if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        if !frac.is_empty() {
            ms = format!("{:0<3}", frac).parse().unwrap_or(0);
        }
    }
    let days = days_from_civil(y, mo, d);
    Some(((days * 24 + h) * 3600 + mi * 60 + se) * 1000 + ms)
}

// Дни от 1970-01-01 (алгоритм Хиннанта) — корректно с високосными.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub const WINDOW_5H_MS: i64 = 5 * 3600 * 1000; // 5-часовое окно лимита
pub const WINDOW_7D_MS: i64 = 7 * 24 * 3600 * 1000; // недельное (7-дневное) окно лимита

// Точка для оконного расчёта: момент + сколько токенов/денег «добавилось» в этот момент
// (для Claude — токены сообщения; для Codex — дельта кумулятива).
#[derive(Debug, Clone, Copy)]
pub struct WindowPoint {
    pub ts_ms: i64,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowBlock {
    pub start_ms: i64,
    pub end_ms: i64,
    pub tokens: u64,
    pub cost_usd: f64,
    pub active: bool,             // окно ещё открыто (now < reset)
    pub burn_rate_per_min: f64,   // токенов/мин по прошедшему времени окна
    pub projected_tokens: u64,    // прогноз на полное 5ч-окно при текущем burn
    pub reset_at_ms: i64,         // start + 5ч
}

fn finalize_block(start: i64, last: i64, tokens: u64, cost: f64, now_ms: i64, window_ms: i64) -> WindowBlock {
    let reset_at_ms = start + window_ms;
    let active = now_ms < reset_at_ms;
    let end_ref = if active { now_ms.max(last) } else { last };
    let elapsed_min = ((end_ref - start) as f64 / 60_000.0).max(1.0);
    let burn = tokens as f64 / elapsed_min;
    let projected_tokens = (burn * (window_ms as f64 / 60_000.0)) as u64;
    WindowBlock {
        start_ms: start,
        end_ms: last,
        tokens,
        cost_usd: cost,
        active,
        burn_rate_per_min: burn,
        projected_tokens,
        reset_at_ms,
    }
}

// Блоки окна `window_ms` (5ч `WINDOW_5H_MS` или недельное `WINDOW_7D_MS`): старт с первой точки;
// точка закрывает блок, если ушла на ≥window от старта ИЛИ образовался разрыв ≥window от предыдущей.
// Последний блок — активный (метрики burn/projected/reset актуальны).
pub fn compute_window_blocks(points: &mut [WindowPoint], now_ms: i64, window_ms: i64) -> Vec<WindowBlock> {
    points.sort_by_key(|p| p.ts_ms);
    let mut blocks = Vec::new();
    let mut cur: Option<(i64, i64, u64, f64)> = None; // (start, last, tokens, cost)
    for p in points.iter() {
        match cur {
            None => cur = Some((p.ts_ms, p.ts_ms, p.tokens, p.cost_usd)),
            Some((start, last, tok, cost)) => {
                if p.ts_ms - start >= window_ms || p.ts_ms - last >= window_ms {
                    blocks.push(finalize_block(start, last, tok, cost, now_ms, window_ms));
                    cur = Some((p.ts_ms, p.ts_ms, p.tokens, p.cost_usd));
                } else {
                    cur = Some((start, p.ts_ms, tok + p.tokens, cost + p.cost_usd));
                }
            }
        }
    }
    if let Some((start, last, tok, cost)) = cur {
        blocks.push(finalize_block(start, last, tok, cost, now_ms, window_ms));
    }
    blocks
}

// Точки окна для Claude — токены сообщения аддитивны.
pub fn claude_points(records: &[UsageRecord]) -> Vec<WindowPoint> {
    records
        .iter()
        .filter(|r| r.vendor == Vendor::Claude)
        .filter_map(|r| {
            let ts_ms = r.ts_iso.as_deref().and_then(iso_to_epoch_ms)?;
            Some(WindowPoint { ts_ms, tokens: r.total_tokens, cost_usd: cost_usd(r).unwrap_or(0.0) })
        })
        .collect()
}

// Точки окна для Codex — total_token_usage КУМУЛЯТИВЕН, считаем дельту шага (иначе кратный
// перерасчёт). Ожидает записи ОДНОЙ сессии в порядке rollout (первая = базовая). $ пока 0 —
// цены Codex отложены (нет LiteLLM-снапшота, OQ1).
pub fn codex_points(records: &[UsageRecord]) -> Vec<WindowPoint> {
    let mut out = Vec::new();
    let mut prev = 0u64;
    for r in records.iter().filter(|r| r.vendor == Vendor::Codex) {
        let ts_ms = match r.ts_iso.as_deref().and_then(iso_to_epoch_ms) {
            Some(t) => t,
            None => continue,
        };
        let delta = r.total_tokens.saturating_sub(prev);
        prev = r.total_tokens;
        out.push(WindowPoint { ts_ms, tokens: delta, cost_usd: 0.0 });
    }
    out
}

// ── Фаза C: контекст per-сессия + индикатор квоты ───────────────────────────────

// Окно контекста модели (токенов). Claude — из справочника claude-api: Opus/Sonnet/Fable = 1M,
// Haiku = 200K. Grok даёт окно прямо в signals (см. context_window_for). Codex/неизвестные → None
// (окно неизвестно — честно None, не подставляем дефолт).
pub fn model_context_window(model: &str) -> Option<u64> {
    let m = model.to_ascii_lowercase();
    if m.contains("haiku") {
        Some(200_000)
    } else if m.contains("opus") || m.contains("sonnet") || m.contains("fable") || m.contains("mythos") {
        Some(1_000_000)
    } else {
        None
    }
}

// Окно контекста записи: Grok — прямое из signals; иначе по модели.
pub fn context_window_for(r: &UsageRecord) -> Option<u64> {
    if let Some(w) = r.context_window {
        return Some(w);
    }
    model_context_window(r.model.as_deref()?)
}

// Доля занятого контекста (0..1) — для бейджа «память N%». None если окно неизвестно (Codex).
pub fn context_pct(r: &UsageRecord) -> Option<f64> {
    let used = r.context_used?;
    let window = context_window_for(r)?;
    if window == 0 {
        return None;
    }
    Some(used as f64 / window as f64)
}

// Индикатор квоты (ОЦЕНКА — официального API остатка нет). Считается от активного 5ч-блока:
// pct = used/limit, остаток, ETA до упора по burn_rate. `at_limit` — проекционный (pct≥1);
// подтверждение баннером «лимит» из вывода терминала — отдельный слой (нужен реальный образец +
// чтение PTY), здесь не делаем. `estimated` всегда true.
#[derive(Debug, Clone, serde::Serialize)]
pub struct QuotaStatus {
    pub plan_limit: u64,
    pub used: u64,
    pub remaining: u64,
    pub pct: f64,
    pub eta_to_limit_ms: Option<i64>, // абсолютный момент упора; None если burn=0
    pub at_limit: bool,
    pub estimated: bool,
}

pub fn compute_quota(block: &WindowBlock, plan_limit: u64, now_ms: i64) -> QuotaStatus {
    let used = block.tokens;
    let remaining = plan_limit.saturating_sub(used);
    let pct = if plan_limit > 0 { used as f64 / plan_limit as f64 } else { 0.0 };
    let eta_to_limit_ms = if block.burn_rate_per_min > 0.0 && remaining > 0 {
        let mins = remaining as f64 / block.burn_rate_per_min;
        Some(now_ms + (mins * 60_000.0) as i64)
    } else {
        None
    };
    QuotaStatus {
        plan_limit,
        used,
        remaining,
        pct,
        eta_to_limit_ms,
        at_limit: pct >= 1.0,
        estimated: true,
    }
}

// Авто-детект лимита плана по СВОЕЙ истории: 90-й перцентиль токенов закрытых 5ч-блоков
// (RFC «авто-детект P90»). Не угаданная константа — из реального расхода пользователя.
// None если истории мало (<3 закрытых блоков).
pub fn estimate_plan_limit_p90(blocks: &[WindowBlock]) -> Option<u64> {
    let mut totals: Vec<u64> = blocks.iter().filter(|b| !b.active).map(|b| b.tokens).collect();
    if totals.len() < 3 {
        return None;
    }
    totals.sort_unstable();
    // индекс 90-го перцентиля (ceil(0.9*n)-1)
    let idx = (((totals.len() as f64) * 0.9).ceil() as usize).saturating_sub(1).min(totals.len() - 1);
    Some(totals[idx])
}

// ── Снимок для UI (Tauri-команда usage_snapshot, PLAN 0004 Фаза D) ──
// Считает по каждому поддержанному CLI квоту за 5ч и 7д из его свежих локальных логов.
// v1: Claude + Codex (у них поток токенов per-message). Grok/прочие — отдельным слоем.
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliWindow {
    pub pct: f64,          // 0..1 доля использования окна (для бара); валидно только при has_pct
    pub used: u64,         // токенов израсходовано в окне (подсказка / когда % нет)
    pub has_pct: bool,     // есть НАСТОЯЩИЙ % (rate_limits CLI), а не оценка
    pub reset_in_min: i64, // минут до сброса окна (0 = неизвестно)
    pub window_min: i64,   // фактическая длина окна источника, мин (300=5ч, 10080=7д, 43200=30д); 0=неизв.
}

impl CliWindow {
    fn tokens_only(used: u64) -> Self {
        CliWindow { pct: 0.0, used, has_pct: false, reset_in_min: 0, window_min: 0 }
    }
    fn empty() -> Self {
        CliWindow { pct: 0.0, used: 0, has_pct: false, reset_in_min: 0, window_min: 0 }
    }
}

// ── Реальные лимиты Claude из данных статусстроки ────────────────────────────────
// Claude Code отдаёт команде statusLine на stdin JSON с .rate_limits.{five_hour,seven_day}
// .{used_percentage,resets_at} — это НАСТОЯЩИЙ остаток квоты аккаунта (тот же, что в терминале),
// account-wide, без трат токенов. Deck читает свежайший дамп этого JSON (свой перехват + дамп
// пользовательской статусстроки) и берёт % напрямую.
#[derive(serde::Deserialize)]
struct StatuslineDump {
    rate_limits: Option<RateLimitsJson>,
}
#[derive(serde::Deserialize)]
struct RateLimitsJson {
    five_hour: Option<RateWindowJson>,
    seven_day: Option<RateWindowJson>,
}
#[derive(serde::Deserialize)]
struct RateWindowJson {
    used_percentage: Option<f64>,
    resets_at: Option<f64>, // unix epoch (секунды)
}

// Кандидаты-дампы (свежайший по mtime выигрывает): перехват Deck + дамп пользовательской
// статусстроки (`statusline.sh` многих кладёт сюда). Оба содержат одинаковый account-wide %.
fn statusline_dump_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    v.push(crate::hooks::claude_statusline_capture_path());
    v.push(PathBuf::from("/tmp/cc_statusline_last.json"));
    v
}

fn claude_rate_limits() -> Option<RateLimitsJson> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for p in statusline_dump_paths() {
        if let Ok(mt) = std::fs::metadata(&p).and_then(|m| m.modified()) {
            if best.as_ref().map_or(true, |(t, _)| mt > *t) {
                best = Some((mt, p));
            }
        }
    }
    let (_, path) = best?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<StatuslineDump>(&text).ok()?.rate_limits
}

// Наложить реальный % из rate_limits Claude на окно (если есть). window_min — длина окна (5ч/7д).
fn apply_rate(w: &mut CliWindow, rw: Option<&RateWindowJson>, window_min: i64, now_ms: i64) {
    if let Some(r) = rw {
        if let Some(p) = r.used_percentage {
            w.pct = (p / 100.0).clamp(0.0, 1.0);
            w.has_pct = true;
            w.window_min = window_min;
        }
        if let Some(reset) = r.resets_at {
            let reset_ms = (reset * 1000.0) as i64;
            w.reset_in_min = ((reset_ms - now_ms) / 60_000).max(0);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliReport {
    pub id: String,    // claude | codex | … (= имя файла логотипа)
    pub name: String,  // каноническое имя (подсказка)
    pub has_data: bool, // умеем ли читать расход этого CLI (Claude/Codex = да; прочие = «—»)
    pub w5: CliWindow, // окно 5 часов
    pub w7: CliWindow, // окно 7 дней
}

// Каталог известных CLI: id (= имя файла логотипа) → отображаемое имя. Порядок = порядок в меню.
const CLI_CATALOG: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("grok", "Grok"),
    ("gemini", "Gemini CLI"),
    ("cursor", "Cursor"),
    ("qwen", "Qwen Code"),
    ("opencode", "opencode"),
];

// «Установлен ли CLI» — по наличию его рабочей папки в $HOME (надёжнее, чем `which`: у .app
// урезанный PATH и бинарь может не найтись, RFC 0009). Расход пока читаем только у claude/codex.
fn cli_installed(id: &str) -> bool {
    let h = home();
    let ex = |p: PathBuf| p.exists();
    match id {
        "claude" => ex(h.join(".claude")),
        "codex" => ex(h.join(".codex")),
        "grok" => ex(h.join(".grok")),
        "gemini" => ex(h.join(".gemini")),
        "cursor" => ex(h.join(".cursor")),
        "qwen" => ex(h.join(".qwen")),
        "opencode" => {
            ex(h.join(".config").join("opencode"))
                || ex(h.join(".opencode"))
                || ex(h.join(".local").join("share").join("opencode"))
        }
        _ => false,
    }
}

fn epoch_ms_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// Свежие файлы под root (рекурсивно, ограниченно): ext + опц. префикс имени + mtime в пределах
// within_ms; новейшие первыми, не больше cap (чтобы не сканировать гигабайты истории).
fn recent_files(root: &Path, ext: &str, prefix: Option<&str>, within_ms: i64, now: i64, cap: usize) -> Vec<PathBuf> {
    fn walk(dir: &Path, ext: &str, prefix: Option<&str>, depth: usize, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
        if depth > 6 {
            return;
        }
        let rd = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, ext, prefix, depth + 1, out);
            } else {
                let ok_ext = p.extension().map_or(false, |x| x == ext);
                let ok_pre = prefix.map_or(true, |pf| {
                    p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with(pf))
                });
                if ok_ext && ok_pre {
                    if let Ok(mt) = e.metadata().and_then(|m| m.modified()) {
                        out.push((mt, p));
                    }
                }
            }
        }
    }
    let mut out: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    walk(root, ext, prefix, 0, &mut out);
    let cutoff = now - within_ms;
    out.retain(|(mt, _)| mt.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) >= cutoff);
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().take(cap).map(|(_, p)| p).collect()
}

fn claude_recent_points(now: i64) -> Vec<WindowPoint> {
    let dir = home().join(".claude").join("projects");
    let mut pts = Vec::new();
    for f in recent_files(&dir, "jsonl", None, WINDOW_7D_MS, now, 80) {
        pts.extend(claude_points(&scan_claude_file(&f)));
    }
    pts
}

// Codex: total_token_usage кумулятивен ПО СЕССИИ — дельты считаем ВНУТРИ каждого файла, потом
// сливаем точки (так дельты корректны, без перескока на границе сессий).
fn codex_recent_points(now: i64) -> Vec<WindowPoint> {
    let dir = home().join(".codex").join("sessions");
    let mut pts = Vec::new();
    for f in recent_files(&dir, "jsonl", Some("rollout-"), WINDOW_7D_MS, now, 80) {
        pts.extend(codex_points(&scan_codex_file(&f)));
    }
    pts
}

// ── Реальные лимиты Codex из rollout-логов ───────────────────────────────────────
// Codex кладёт в события rollout (~/.codex/sessions/**/rollout-*.jsonl) поле payload.rate_limits
// с окнами primary/secondary: used_percent + window_minutes (300=5ч, 10080=7д, 43200=30д) +
// resets_at (unix epoch). Account-wide. Берём свежайший снимок и раскладываем окна по 5ч/7д.
#[derive(serde::Deserialize)]
struct CodexRlLine {
    payload: Option<CodexRlPayload>,
}
#[derive(serde::Deserialize)]
struct CodexRlPayload {
    rate_limits: Option<CodexRateLimits>,
}
#[derive(serde::Deserialize)]
struct CodexRateLimits {
    primary: Option<CodexRateWin>,
    secondary: Option<CodexRateWin>,
}
#[derive(serde::Deserialize, Clone)]
struct CodexRateWin {
    used_percent: Option<f64>,
    window_minutes: Option<i64>,
    resets_at: Option<f64>,
}

// Свежайший снимок rate_limits Codex (окна primary+secondary, непустые).
fn codex_rate_windows(now: i64) -> Vec<CodexRateWin> {
    let dir = home().join(".codex").join("sessions");
    for f in recent_files(&dir, "jsonl", Some("rollout-"), WINDOW_7D_MS, now, 20) {
        let text = match std::fs::read_to_string(&f) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for line in text.lines().rev() {
            if !line.contains("rate_limits") {
                continue;
            }
            if let Ok(l) = serde_json::from_str::<CodexRlLine>(line) {
                if let Some(rl) = l.payload.and_then(|p| p.rate_limits) {
                    let mut v = Vec::new();
                    if let Some(p) = rl.primary {
                        v.push(p);
                    }
                    if let Some(s) = rl.secondary {
                        v.push(s);
                    }
                    if v.iter().any(|w| w.used_percent.is_some()) {
                        return v;
                    }
                }
            }
        }
    }
    Vec::new()
}

// Наложить на окно слот Codex для выбранного горизонта (план-зависимо: 5ч/7д/30д). Ищем окно в
// диапазоне min..max ближайшее к target; если такого нет (напр. free-план без 5ч-окна) —
// ФОЛБЭК на первое доступное окно (primary), чтобы показать реальный остаток с его настоящей
// длиной (window_min), а не пустоту. UI подпишет фактическое окно («30д»).
fn apply_codex_rate(w: &mut CliWindow, wins: &[CodexRateWin], target_min: i64, min_min: i64, max_min: i64, now_ms: i64) {
    let pick = wins
        .iter()
        .filter(|x| x.used_percent.is_some())
        .filter(|x| x.window_minutes.map_or(false, |m| m >= min_min && m <= max_min))
        .min_by_key(|x| (x.window_minutes.unwrap_or(0) - target_min).abs())
        .or_else(|| wins.iter().find(|x| x.used_percent.is_some()));
    if let Some(x) = pick {
        if let Some(p) = x.used_percent {
            w.pct = (p / 100.0).clamp(0.0, 1.0);
            w.has_pct = true;
            w.window_min = x.window_minutes.unwrap_or(0);
        }
        if let Some(reset) = x.resets_at {
            w.reset_in_min = (((reset * 1000.0) as i64 - now_ms) / 60_000).max(0);
        }
    }
}

// Расход токенов в текущем окне (для подсказки / когда настоящего % нет). % сюда НЕ кладём —
// реальный % накладывается отдельно из rate_limits (Claude/Codex).
fn window_used(mut points: Vec<WindowPoint>, now: i64, window_ms: i64) -> CliWindow {
    let blocks = compute_window_blocks(&mut points, now, window_ms);
    CliWindow::tokens_only(blocks.last().map(|b| b.tokens).unwrap_or(0))
}

// Снимок для виджета: ВСЕ установленные CLI (чтобы можно было закрепить «＋»). Claude — НАСТОЯЩИЙ
// % из rate_limits статусстроки (как в терминале, без ввода лимита); Codex — токены окна; прочие
// установленные — «—» (расход пока не читаем).
pub fn usage_report() -> Vec<CliReport> {
    let now = epoch_ms_now();
    let rl = claude_rate_limits();
    let mut out = Vec::new();
    for (id, name) in CLI_CATALOG {
        if !cli_installed(id) {
            continue;
        }
        let (w5, w7, has_data) = match *id {
            "claude" => {
                let p = claude_recent_points(now);
                let mut w5 = window_used(p.clone(), now, WINDOW_5H_MS);
                let mut w7 = window_used(p, now, WINDOW_7D_MS);
                if let Some(ref r) = rl {
                    apply_rate(&mut w5, r.five_hour.as_ref(), 300, now); // 5ч = 300 мин
                    apply_rate(&mut w7, r.seven_day.as_ref(), 10080, now); // 7д = 10080 мин
                }
                (w5, w7, true)
            }
            "codex" => {
                let p = codex_recent_points(now);
                (window_used(p.clone(), now, WINDOW_5H_MS), window_used(p, now, WINDOW_7D_MS), true)
            }
            // установлен, но расход пока не парсим → «—» (можно закрепить наверх)
            _ => (CliWindow::empty(), CliWindow::empty(), false),
        };
        out.push(CliReport { id: (*id).into(), name: (*name).into(), has_data, w5, w7 });
    }
    out
}

#[cfg(test)]
mod context_tests {
    use super::*;

    #[test]
    fn context_window_by_model_and_grok_direct() {
        assert_eq!(model_context_window("claude-opus-4-8"), Some(1_000_000));
        assert_eq!(model_context_window("claude-sonnet-4-6"), Some(1_000_000));
        assert_eq!(model_context_window("claude-haiku-4-5"), Some(200_000));
        assert_eq!(model_context_window("claude-fable-5"), Some(1_000_000));
        assert_eq!(model_context_window("gpt-5-codex"), None); // окно неизвестно
    }

    #[test]
    fn context_pct_claude_and_grok() {
        // Claude: used = input(18591)+cache_read(15469)=34060, окно 1M → 0.03406
        let line = r#"{"type":"assistant","timestamp":"2026-05-30T11:55:22.693Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":18591,"output_tokens":1161,"cache_creation_input_tokens":8821,"cache_read_input_tokens":15469}}}"#;
        let r = parse_claude_line(line).unwrap();
        assert!((context_pct(&r).unwrap() - 0.034_060).abs() < 1e-6);
        // Grok: used 40862 / окно 200000 = 0.20431 (окно прямое из signals)
        let g = parse_grok_signals(r#"{"contextTokensUsed":40862,"contextWindowTokens":200000,"primaryModelId":"grok-x"}"#).unwrap();
        assert!((context_pct(&g).unwrap() - 0.20431).abs() < 1e-6);
    }

    #[test]
    fn quota_projection() {
        let blk = WindowBlock {
            start_ms: 0,
            end_ms: 60 * 60_000, // последняя трата на 60-й минуте
            tokens: 50_000,
            cost_usd: 0.0,
            active: true,
            burn_rate_per_min: 1_000.0, // 1000 ток/мин
            projected_tokens: 0,
            reset_at_ms: WINDOW_5H_MS,
        };
        let now = 60 * 60_000;
        let q = compute_quota(&blk, 100_000, now);
        assert_eq!(q.used, 50_000);
        assert_eq!(q.remaining, 50_000);
        assert!((q.pct - 0.5).abs() < 1e-9);
        assert!(!q.at_limit);
        // ETA: 50000 остатка / 1000 в мин = 50 мин → now + 50*60000
        assert_eq!(q.eta_to_limit_ms, Some(now + 50 * 60_000));
        // при превышении — at_limit
        let q2 = compute_quota(&blk, 40_000, now);
        assert!(q2.at_limit);
        assert_eq!(q2.remaining, 0);
    }

    #[test]
    fn p90_from_history() {
        let mk = |tok: u64, active: bool| WindowBlock {
            start_ms: 0, end_ms: 0, tokens: tok, cost_usd: 0.0, active,
            burn_rate_per_min: 0.0, projected_tokens: 0, reset_at_ms: 0,
        };
        // 10 закрытых блоков 100..1000 → P90 = 900; активный игнорируется
        let mut blks: Vec<WindowBlock> = (1..=10).map(|i| mk(i * 100, false)).collect();
        blks.push(mk(999_999, true));
        assert_eq!(estimate_plan_limit_p90(&blks), Some(900));
        // мало истории → None
        assert_eq!(estimate_plan_limit_p90(&[mk(100, false), mk(200, false)]), None);
    }
}

#[cfg(test)]
mod cost_tests {
    use super::*;

    #[test]
    fn prices_match_reference() {
        let o = price_for_model("claude-opus-4-8").unwrap();
        assert_eq!(o.input, 5.0);
        assert_eq!(o.output, 25.0);
        assert_eq!(o.cache_write_5m, 6.25);
        assert_eq!(o.cache_write_1h, 10.0);
        assert_eq!(o.cache_read, 0.5);
        assert_eq!(price_for_model("claude-sonnet-4-6").unwrap().input, 3.0);
        assert_eq!(price_for_model("claude-haiku-4-5").unwrap().output, 5.0);
        assert_eq!(price_for_model("claude-fable-5").unwrap().input, 10.0);
        // codex/grok/неизвестные — цены нет (до LiteLLM-снапшота)
        assert!(price_for_model("gpt-5-codex").is_none());
        assert!(price_for_model("grok-composer-2.5-fast").is_none());
    }

    #[test]
    fn cost_of_real_claude_record() {
        // строка построена по реальной структуре Claude-лога (как в mod tests)
        let line = r#"{"type":"assistant","timestamp":"2026-05-30T11:55:22.693Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":18591,"output_tokens":1161,"cache_creation_input_tokens":8821,"cache_read_input_tokens":15469}}}"#;
        let r = parse_claude_line(line).unwrap();
        let c = cost_usd(&r).unwrap();
        // 18591*5 + 1161*25 + 8821*6.25 + 15469*0.5 = 184845.75 / 1e6
        assert!((c - 0.184_845_75).abs() < 1e-9, "cost={c}");
    }

    #[test]
    fn iso_parses_and_orders() {
        assert_eq!(iso_to_epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_to_epoch_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        let claude = iso_to_epoch_ms("2026-05-30T11:55:22.693Z").unwrap();
        let codex = iso_to_epoch_ms("2026-04-20T12:23:42.957Z").unwrap();
        assert!(claude > codex, "май позже апреля");
        assert!(iso_to_epoch_ms("мусор").is_none());
    }

    #[test]
    fn window_groups_by_5h_and_gap() {
        let base = iso_to_epoch_ms("2026-05-30T10:00:00Z").unwrap();
        let hr = 3_600_000i64;
        // две точки в пределах 5ч → один блок; третья через 6ч → второй блок
        let mut pts = vec![
            WindowPoint { ts_ms: base, tokens: 100, cost_usd: 1.0 },
            WindowPoint { ts_ms: base + hr, tokens: 50, cost_usd: 0.5 },
            WindowPoint { ts_ms: base + 6 * hr, tokens: 200, cost_usd: 2.0 },
        ];
        let now = base + 6 * hr + hr; // 7ч от старта
        let blocks = compute_window_blocks(&mut pts, now, WINDOW_5H_MS);
        assert_eq!(blocks.len(), 2, "ожидалось 2 окна");
        assert_eq!(blocks[0].tokens, 150);
        assert!((blocks[0].cost_usd - 1.5).abs() < 1e-9);
        assert!(!blocks[0].active, "первое окно закрыто");
        assert_eq!(blocks[1].tokens, 200);
        assert!(blocks[1].active, "второе окно ещё открыто (reset через 5ч от его старта)");
        assert_eq!(blocks[1].reset_at_ms, base + 6 * hr + WINDOW_5H_MS);
    }

    #[test]
    fn window_7d_groups_by_week() {
        let base = iso_to_epoch_ms("2026-05-01T00:00:00Z").unwrap();
        let day = 86_400_000i64;
        // в пределах 7д (старт..+3д) — один блок; через 10д — новый (≥7д и от старта, и разрыв)
        let mut pts = vec![
            WindowPoint { ts_ms: base, tokens: 100, cost_usd: 0.0 },
            WindowPoint { ts_ms: base + 3 * day, tokens: 50, cost_usd: 0.0 },
            WindowPoint { ts_ms: base + 10 * day, tokens: 200, cost_usd: 0.0 },
        ];
        let blocks = compute_window_blocks(&mut pts, base + 11 * day, WINDOW_7D_MS);
        assert_eq!(blocks.len(), 2, "недельная группировка: 2 окна");
        assert_eq!(blocks[0].tokens, 150);
        assert_eq!(blocks[1].tokens, 200);
        assert_eq!(blocks[1].reset_at_ms, base + 10 * day + WINDOW_7D_MS);
    }

    #[test]
    fn codex_points_diff_cumulative() {
        // кумулятив 16183 → 20000 → 20100 = дельты 16183, 3817, 100
        let mk = |total: u64| UsageRecord {
            vendor: Vendor::Codex,
            session_id: None,
            cwd: None,
            model: None,
            ts_iso: Some("2026-04-20T12:23:42.957Z".into()),
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: total,
            context_used: Some(total),
            context_window: None,
            request_id: None,
            message_id: None,
        };
        let recs = vec![mk(16183), mk(20000), mk(20100)];
        let pts = codex_points(&recs);
        assert_eq!(pts.iter().map(|p| p.tokens).collect::<Vec<_>>(), vec![16183, 3817, 100]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Фикстуры построены по РЕАЛЬНОЙ структуре логов (сняты с машины 2026-06-15), id/cwd —
    // плейсхолдеры (без приватного содержимого).
    const CLAUDE_LINE: &str = r#"{"type":"assistant","timestamp":"2026-05-30T11:55:22.693Z","sessionId":"sess-1","cwd":"/Users/x/proj","requestId":"req-1","message":{"id":"msg-1","model":"claude-opus-4-8","usage":{"input_tokens":18591,"output_tokens":1161,"cache_creation_input_tokens":8821,"cache_read_input_tokens":15469}}}"#;
    const CLAUDE_USER_LINE: &str = r#"{"type":"user","timestamp":"2026-05-30T11:55:00.000Z","message":{"role":"user","content":"hi"}}"#;
    const CODEX_LINE: &str = r#"{"timestamp":"2026-04-20T12:23:42.957Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":15872,"cached_input_tokens":10624,"output_tokens":311,"reasoning_output_tokens":114,"total_tokens":16183}}}}"#;
    const GROK_SIGNALS: &str = r#"{"turnCount":1,"contextWindowUsage":20,"contextTokensUsed":40862,"contextWindowTokens":200000,"primaryModelId":"grok-composer-2.5-fast","toolCallCount":34}"#;

    #[test]
    fn claude_parses_usage_and_skips_non_assistant() {
        let r = parse_claude_line(CLAUDE_LINE).expect("assistant-строка должна парситься");
        assert_eq!(r.vendor, Vendor::Claude);
        assert_eq!(r.input_tokens, 18591);
        assert_eq!(r.output_tokens, 1161);
        assert_eq!(r.cache_creation_tokens, 8821);
        assert_eq!(r.cache_read_tokens, 15469);
        assert_eq!(r.context_used, Some(18591 + 15469)); // вход + кэш-чтение
        assert_eq!(r.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(r.session_id.as_deref(), Some("sess-1"));
        assert_eq!(r.message_id.as_deref(), Some("msg-1"));
        assert!(parse_claude_line(CLAUDE_USER_LINE).is_none(), "user-строка — не расход");
        assert!(parse_claude_line("не json").is_none());
    }

    #[test]
    fn codex_parses_cumulative_token_count() {
        let r = parse_codex_line(CODEX_LINE).expect("token_count должен парситься");
        assert_eq!(r.vendor, Vendor::Codex);
        assert_eq!(r.input_tokens, 15872);
        assert_eq!(r.output_tokens, 311);
        assert_eq!(r.cache_read_tokens, 10624);
        assert_eq!(r.total_tokens, 16183); // кумулятив
        // не-token_count событие → None
        assert!(parse_codex_line(r#"{"type":"event_msg","payload":{"type":"agent_message"}}"#).is_none());
    }

    #[test]
    fn grok_parses_direct_context() {
        let r = parse_grok_signals(GROK_SIGNALS).expect("signals.json должен парситься");
        assert_eq!(r.vendor, Vendor::Grok);
        assert_eq!(r.context_used, Some(40862));
        assert_eq!(r.context_window, Some(200000));
        assert_eq!(r.model.as_deref(), Some("grok-composer-2.5-fast"));
    }

    #[test]
    fn dedup_collapses_same_message_request() {
        let recs = vec![
            parse_claude_line(CLAUDE_LINE).unwrap(),
            parse_claude_line(CLAUDE_LINE).unwrap(), // дубль (та же пара id)
        ];
        assert_eq!(dedup_claude(recs).len(), 1, "одинаковые (msg_id,req_id) схлопываются");
    }

    #[test]
    fn cwd_encoding_matches_vendor_layout() {
        assert!(claude_project_dir("/Users/x/proj")
            .to_string_lossy()
            .ends_with(".claude/projects/-Users-x-proj"));
        assert!(grok_cwd_dir("/Users/x/proj")
            .to_string_lossy()
            .ends_with(".grok/sessions/%2FUsers%2Fx%2Fproj"));
    }

    // Smoke-тест на ЖИВЫХ логах (mock≠prod): если на машине есть реальные логи — парсер обязан
    // достать ≥1 запись. Где логов нет (CI/чужая машина) — тест проходит вхолостую.
    #[test]
    fn live_logs_parse_when_present() {
        let proj = home().join(".claude").join("projects");
        if !proj.exists() {
            return; // нет логов — пропуск
        }
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        for d in std::fs::read_dir(&proj).into_iter().flatten().flatten() {
            for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                let p = f.path();
                if p.extension().map_or(false, |e| e == "jsonl") {
                    if let Ok(mt) = f.metadata().and_then(|m| m.modified()) {
                        if newest.as_ref().map_or(true, |(t, _)| mt > *t) {
                            newest = Some((mt, p));
                        }
                    }
                }
            }
        }
        if let Some((_, path)) = newest {
            let recs = scan_claude_file(&path);
            assert!(
                !recs.is_empty(),
                "живой Claude-лог {:?} должен дать ≥1 запись расхода",
                path
            );
        }
    }
}
