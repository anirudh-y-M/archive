// Scroll progress bar.
// This script runs on every SPA "nav" event.

document.addEventListener("nav", () => {
  // -----------------------------------------------------------------------
  // SCROLL PROGRESS BAR
  //    Updates the .navigation-progress bar width as the user scrolls.
  // -----------------------------------------------------------------------

  const progressBar = document.querySelector(".navigation-progress") as HTMLElement | null
  if (progressBar) {
    const updateProgress = () => {
      const scrollTop = window.scrollY
      const docHeight = document.documentElement.scrollHeight - window.innerHeight
      if (docHeight > 0) {
        const progress = Math.min((scrollTop / docHeight) * 100, 100)
        progressBar.style.width = `${progress}%`
      }
    }

    // Initial update
    updateProgress()

    window.addEventListener("scroll", updateProgress, { passive: true })
    window.addCleanup(() => window.removeEventListener("scroll", updateProgress))
  }
})
