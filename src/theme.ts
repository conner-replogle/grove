// The window's colors follow its workspace, as in Zen: every themed token
// (zen/tokens.css) is derived from --ws-color on webui-browser-app.
// Registering it as a color lets a workspace switch fade from one color to
// the next (app.css transitions it).
try {
  CSS.registerProperty({ name: '--ws-color', syntax: '<color>', inherits: true, initialValue: '#8e8e93' })
} catch {
  // Already registered (the bundle was evaluated twice).
}

export function applyWorkspaceTheme(app: Element, color: string): void {
  ;(app as HTMLElement).style.setProperty('--ws-color', color)
}
