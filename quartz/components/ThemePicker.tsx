// @ts-ignore
import themepickerScript from "./scripts/themepicker.inline"
import styles from "./styles/themepicker.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const ThemePicker: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <button class={classNames(displayClass, "theme-picker")} aria-label="Change color theme" title="Ocean">
      <span class="theme-icon">🌊</span>
    </button>
  )
}

ThemePicker.beforeDOMLoaded = themepickerScript
ThemePicker.css = styles

export default (() => ThemePicker) satisfies QuartzComponentConstructor
