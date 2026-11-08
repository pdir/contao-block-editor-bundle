<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\DataContainer;

use Contao\System;
use Symfony\Component\HttpFoundation\Request;

/**
 * Runs the onload callbacks of a table as the back end does before it shows the edit form of a
 * record. Other bundles add their fields to the palettes there, some only when the request
 * edits a record ("act=edit"), such as the CSS style selector and the advanced classes.
 */
final class EditContext
{
    /**
     * Messages the callbacks leave for the back end form are not kept: the editor shows none.
     *
     * @param bool $lenient Whether a failing callback is skipped, which is fine for reading: its
     *                      fields stay in the classic back end
     */
    public static function load(string $table, EditorDataContainer $dc, Request|null $request, bool $lenient = false): void
    {
        $callbacks = $GLOBALS['TL_DCA'][$table]['config']['onload_callback'] ?? null;

        if (!\is_array($callbacks) || !$callbacks) {
            return;
        }

        $query = $request?->query->all();
        $request?->query->add(['act' => 'edit', 'id' => (string) $dc->id]);

        $session = $request?->hasSession() ? $request->getSession() : null;
        $flashBag = null !== $session && $session->isStarted() && method_exists($session, 'getFlashBag') ? $session->getFlashBag() : null;
        $flashes = $flashBag?->peekAll();

        try {
            foreach ($callbacks as $callback) {
                try {
                    if (\is_array($callback)) {
                        System::importStatic($callback[0])->{$callback[1]}($dc);
                    } elseif (\is_callable($callback)) {
                        $callback($dc);
                    }
                } catch (\Throwable $exception) {
                    if (!$lenient) {
                        throw $exception;
                    }
                }
            }
        } finally {
            if (null !== $query) {
                $request->query->replace($query);
            }

            if (null !== $flashes) {
                $flashBag->setAll($flashes);
            }
        }
    }

    /**
     * Runs the callbacks for one record and gives the table's DCA back as it was afterwards, so
     * that one record does not change the fields of the next.
     *
     * @template T
     *
     * @param \Closure(): T $inside
     *
     * @return T
     */
    public static function forRecord(string $table, EditorDataContainer $dc, Request|null $request, \Closure $inside): mixed
    {
        $dca = $GLOBALS['TL_DCA'][$table];

        try {
            self::load($table, $dc, $request, true);

            return $inside();
        } finally {
            $GLOBALS['TL_DCA'][$table] = $dca;
        }
    }
}
