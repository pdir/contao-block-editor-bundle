// Loaded as a classic script in the head, so the stored width, inspector and corners apply before the
// first paint instead of flashing the defaults.
import { applyCorners, applyInspector, applyViewport, storedInspector, storedRoundCorners, storedViewport } from './settings';

applyViewport(document.documentElement, storedViewport());
applyInspector(document.documentElement, storedInspector());
applyCorners(document.documentElement, storedRoundCorners());
