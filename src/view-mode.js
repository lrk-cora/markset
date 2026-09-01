import { disarmDrawing } from './overlay.js'
import { clearSelection } from './store.js'

/** Hide lasso, badges, and the command bar so the page reads as the finished result. */
export function exitToView() {
  clearSelection()
  disarmDrawing()
}
