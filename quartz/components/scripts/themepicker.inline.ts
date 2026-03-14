// Theme picker: cycles through color palettes. Works alongside the light/dark toggle.
// Each theme overrides --secondary, --tertiary, --highlight, --textHighlight
// via a [data-theme="name"] attribute on :root.

interface ThemeDef {
  name: string
  icon: string // emoji shown in the button
  label: string
}

const THEMES: ThemeDef[] = [
  { name: "ocean", icon: "🌊", label: "Ocean" },
  { name: "rose", icon: "🌸", label: "Rosé" },
  { name: "emerald", icon: "🌿", label: "Emerald" },
  { name: "amber", icon: "🔥", label: "Amber" },
  { name: "violet", icon: "🔮", label: "Violet" },
  { name: "mono", icon: "🖤", label: "Mono" },
]

const STORAGE_KEY = "color-theme"

function applyTheme(themeName: string) {
  document.documentElement.setAttribute("data-theme", themeName)
  localStorage.setItem(STORAGE_KEY, themeName)
}

function getCurrentTheme(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "ocean"
}

// Apply saved theme immediately (before nav fires)
applyTheme(getCurrentTheme())

document.addEventListener("nav", () => {
  const current = getCurrentTheme()
  applyTheme(current)

  // Update all picker buttons
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".theme-picker")) {
    const currentIdx = THEMES.findIndex((t) => t.name === current)
    btn.querySelector(".theme-icon")!.textContent = THEMES[currentIdx >= 0 ? currentIdx : 0].icon
    btn.setAttribute("aria-label", `Theme: ${THEMES[currentIdx >= 0 ? currentIdx : 0].label}`)
    btn.setAttribute("title", THEMES[currentIdx >= 0 ? currentIdx : 0].label)

    const handleClick = () => {
      const cur = getCurrentTheme()
      const idx = THEMES.findIndex((t) => t.name === cur)
      const nextIdx = (idx + 1) % THEMES.length
      const next = THEMES[nextIdx]
      applyTheme(next.name)

      // Update button
      btn.querySelector(".theme-icon")!.textContent = next.icon
      btn.setAttribute("aria-label", `Theme: ${next.label}`)
      btn.setAttribute("title", next.label)

      // Little bounce animation
      btn.style.transform = "scale(1.3)"
      setTimeout(() => {
        btn.style.transform = ""
      }, 150)
    }

    btn.addEventListener("click", handleClick)
    window.addCleanup(() => btn.removeEventListener("click", handleClick))
  }
})
