// RFC 0011: помощник цвета git-статуса файла. Отдельный список «Изменения» убран
// по просьбе пользователя — изменённые файлы подсвечиваются прямо в дереве (FileTree),
// клик по такому открывает вкладку Diff. Здесь остался только общий цвет статуса.
//  modified — янтарный, added — зелёный, deleted/renamed — красный, untracked — серый.
export function statusColor(status: string): string {
  switch (status) {
    case 'added':
      return '#3fb950'
    case 'deleted':
    case 'renamed':
      return '#f85149'
    case 'untracked':
      return '#8b949e'
    case 'modified':
    default:
      return '#d29922'
  }
}
