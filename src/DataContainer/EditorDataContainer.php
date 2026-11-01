<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\DataContainer;

use Contao\Backend;
use Contao\DC_Table;

/**
 * The data container handed to DCA callbacks when an element is saved through the
 * editor. Core and third-party callbacks type-hint DC_Table, so it has to be one;
 * DC_Table's constructor is skipped on purpose, because it dispatches on the
 * current request (Input::get('act'), redirects, ...) instead of a given record.
 */
final class EditorDataContainer extends DC_Table
{
    /**
     * @param array<string, mixed> $record
     */
    public function __construct(string $table, array $record)
    {
        Backend::__construct();

        $this->strTable = $table;
        $this->intId = (int) ($record['id'] ?? 0);
        $this->ptable = $record['ptable'] ?? null;
        $this->objActiveRecord = (object) $record;
    }

    public function setField(string $field): void
    {
        $this->strField = $field;
        $this->strInputName = $field;
    }
}
