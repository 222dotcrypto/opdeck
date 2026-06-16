fn main() {
  // пересобирать, если поменялась папка состояния (для варианта «Deck Dev»)
  println!("cargo:rerun-if-env-changed=DECK_STATE_DIR");
  tauri_build::build()
}
