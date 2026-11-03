<?php

// No strict_types on purpose: DC_Table calls the DCA callbacks in coercive mode, and callbacks
// rely on it. Contao's own ondelete callback expects the undo ID as a string, for example.

namespace Pdir\ContaoBlockEditorBundle\DataContainer;

use Contao\System;

/**
 * Calls DCA callbacks the way DC_Table does.
 */
final class CallbackInvoker
{
    /**
     * @param array<mixed> $callbacks
     */
    public static function invokeAll(mixed $callbacks, mixed ...$arguments): void
    {
        if (!\is_array($callbacks)) {
            return;
        }

        foreach ($callbacks as $callback) {
            if (\is_array($callback)) {
                System::importStatic($callback[0])->{$callback[1]}(...$arguments);
            } elseif (\is_callable($callback)) {
                $callback(...$arguments);
            }
        }
    }
}
