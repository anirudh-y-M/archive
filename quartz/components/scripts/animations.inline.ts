// Scroll-triggered reveal animations, staggered list items, and scroll progress bar.
// This script runs on every SPA "nav" event.

document.addEventListener("nav", () => {
  // -----------------------------------------------------------------------
  // 1. SCROLL-TRIGGERED REVEAL using IntersectionObserver
  //    Adds .scroll-reveal to headings, code blocks, tables, callouts,
  //    blockquotes, and images inside the article.  When they enter the
  //    viewport, .scroll-visible is added to trigger the CSS transition.
  // -----------------------------------------------------------------------

  const article = document.querySelector(".center > article")
  if (!article) return

  const revealSelectors = [
    ":scope > h2",
    ":scope > h3",
    ":scope > h4",
    ":scope > h5",
    ":scope > h6",
    ":scope > figure[data-rehype-pretty-code-figure]",
    ":scope > pre",
    ":scope > .table-container",
    ":scope > blockquote",
    ":scope > .callout",
    ":scope > img",
    ":scope > p:has(> img)",
  ]

  const revealElements = article.querySelectorAll(revealSelectors.join(", "))

  revealElements.forEach((el) => {
    el.classList.add("scroll-reveal")
  })

  // -----------------------------------------------------------------------
  // 2. STAGGERED LIST ANIMATIONS
  //    Any <ul> or <ol> with >= 3 items gets .list-animate.  When it
  //    enters the viewport, .scroll-visible triggers the staggered CSS.
  // -----------------------------------------------------------------------

  const lists = article.querySelectorAll(":scope > ul, :scope > ol")
  lists.forEach((list) => {
    if (list.children.length >= 3) {
      list.classList.add("scroll-reveal", "list-animate")
    }
  })

  // -----------------------------------------------------------------------
  // 3. INTERSECTION OBSERVER -- single observer for all reveal targets
  // -----------------------------------------------------------------------

  const allTargets = article.querySelectorAll(".scroll-reveal")

  // Respect reduced motion
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  if (prefersReducedMotion) {
    allTargets.forEach((el) => el.classList.add("scroll-visible"))
    return // skip observer and scroll listener
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("scroll-visible")
          observer.unobserve(entry.target) // animate once
        }
      })
    },
    {
      root: null,
      rootMargin: "0px 0px -60px 0px", // trigger slightly before fully visible
      threshold: 0.08,
    },
  )

  allTargets.forEach((el) => observer.observe(el))

  // Clean up observer on SPA navigation
  window.addCleanup(() => observer.disconnect())

  // -----------------------------------------------------------------------
  // 4. SCROLL PROGRESS BAR
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
