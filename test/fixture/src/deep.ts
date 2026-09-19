// deep shared module: types.ts -> deep.ts -> barrel.ts -> dependents
import type { WidgetLabel, WidgetShape } from './types'

export function defaultShape(label: WidgetLabel): WidgetShape {
	return { id: label, scale: 1 }
}
