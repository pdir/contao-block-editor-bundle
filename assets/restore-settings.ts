// Loaded as a classic script in the head, so the stored width and inspector apply before the
// first paint instead of flashing the defaults.
import { applyInspector, applyViewport, storedInspector, storedViewport } from './settings';

applyViewport(document.documentElement, storedViewport());
applyInspector(document.documentElement, storedInspector());
