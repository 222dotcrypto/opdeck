import type { DeckApi } from '../../preload/index'

declare global {
  interface Window {
    api: DeckApi
  }
}

export {}
