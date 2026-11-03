<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\BackendUser;
use Contao\Controller;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\DeleteAction;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\StringUtil;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\CallbackInvoker;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Deletes an element with the elements nested in it. It follows DC_Table::delete(): the
 * voters decide, the records go to tl_undo, the ondelete callbacks run. Restoring follows
 * DC_Table::undo(), so an element deleted in the editor can also be restored in the back
 * end ("Wiederherstellen") and the other way round.
 */
final class ElementDeleter
{
    private const TABLE = ElementInspector::TABLE;
    private const MAX_DEPTH = 100;

    public function __construct(
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly ElementInspector $inspector,
        private readonly LoggerInterface $logger,
    ) {
    }

    /**
     * @return array{deleted: list<int>, undo: int|null}
     */
    public function delete(int $id, string $revision): array
    {
        $this->inspector->loadDca();

        if ($GLOBALS['TL_DCA'][self::TABLE]['config']['notDeletable'] ?? false) {
            throw new ApiException(403, 'Elemente dürfen nicht gelöscht werden.');
        }

        $this->connection->beginTransaction();

        try {
            $result = $this->doDelete($id, $revision);
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }

        return $result;
    }

    /**
     * Puts the records of a deletion back, unless something is in their place by now.
     */
    public function restore(int $undoId): void
    {
        $this->inspector->loadDca();
        $this->connection->beginTransaction();

        try {
            $this->doRestore($undoId);
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }
    }

    /**
     * @return array{deleted: list<int>, undo: int|null}
     */
    private function doDelete(int $id, string $revision): array
    {
        $row = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ? FOR UPDATE', [$id]);

        if (false === $row || !\in_array($row['ptable'], ElementInspector::supportedPtables(), true) || !$this->isGranted(new ReadAction(self::TABLE, $row))) {
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }

        if (!$this->isGranted(new DeleteAction(self::TABLE, $row))) {
            throw new ApiException(403, 'Dieses Element darfst du nicht löschen.');
        }

        if (!hash_equals(ElementInspector::revision($row), $revision)) {
            throw new ApiException(409, 'Das Element wurde zwischenzeitlich geändert. Bitte die Seite neu laden.');
        }

        // The records by table, parents first, as DC_Table::deleteChildren() collects them
        $delete = [self::TABLE => [$id]];
        $this->collectChildren(self::TABLE, $id, $delete, 0);

        $data = [];
        $affected = 0;

        foreach ($delete as $table => $ids) {
            foreach ($ids as $key => $recordId) {
                $record = $this->connection->fetchAssociative("SELECT * FROM $table WHERE id = ?", [$recordId]);

                if (false !== $record) {
                    $data[$table][$key] = $record;
                }

                ++$affected;
            }
        }

        $user = $this->security->getUser();
        $userId = $user instanceof BackendUser ? (int) $user->id : 0;
        $query = 'DELETE FROM '.self::TABLE.' WHERE id='.$id;

        $this->connection->insert('tl_undo', [
            'pid' => $userId,
            'tstamp' => time(),
            'fromTable' => self::TABLE,
            $this->connection->quoteIdentifier('query') => $query,
            'affectedRows' => $affected,
            $this->connection->quoteIdentifier('data') => serialize($data),
        ]);

        $undoId = (int) $this->connection->lastInsertId();
        $dc = new EditorDataContainer(self::TABLE, $row);

        CallbackInvoker::invokeAll($GLOBALS['TL_DCA'][self::TABLE]['config']['ondelete_callback'] ?? null, $dc, $undoId);

        $dc->invalidateCacheTags();

        // Children first, against foreign key errors
        foreach (array_reverse($delete) as $table => $ids) {
            foreach (array_reverse($ids) as $recordId) {
                $this->connection->delete($table, ['id' => $recordId]);
            }
        }

        $this->logger->info($query);

        return [
            'deleted' => array_map(intval(...), $delete[self::TABLE]),
            'undo' => $this->canRestore(['id' => $undoId, 'pid' => $userId]) ? $undoId : null,
        ];
    }

    private function doRestore(int $undoId): void
    {
        $undo = $this->connection->fetchAssociative('SELECT * FROM tl_undo WHERE id = ? FOR UPDATE', [$undoId]);

        if (false === $undo || self::TABLE !== $undo['fromTable'] || !$this->canRestore($undo)) {
            throw new ApiException(404, 'Das gelöschte Element wurde nicht gefunden.');
        }

        $data = StringUtil::deserialize($undo['data']);

        if (!\is_array($data) || !\is_array($data[self::TABLE] ?? null)) {
            throw new ApiException(422, 'Das Element kann nicht wiederhergestellt werden.');
        }

        $restored = null;

        foreach ($data as $table => $records) {
            if (!\is_string($table) || !\is_array($records)) {
                continue;
            }

            Controller::loadDataContainer($table);

            $columns = array_flip(array_map(
                static fn ($column): string => $column->getName(),
                $this->connection->createSchemaManager()->listTableColumns($table),
            ));

            foreach ($records as $record) {
                $record = array_intersect_key((array) $record, $columns);

                if ($this->connection->fetchOne("SELECT 1 FROM $table WHERE id = ?", [$record['id'] ?? 0])) {
                    throw new ApiException(409, 'Das Element ist schon wieder da.');
                }

                $this->connection->insert($table, array_combine(array_map($this->connection->quoteIdentifier(...), array_keys($record)), $record));
                $restored ??= $record;

                CallbackInvoker::invokeAll($GLOBALS['TL_DCA'][$table]['config']['onundo_callback'] ?? null, $table, $record, new EditorDataContainer($table, $record));
            }
        }

        $this->connection->delete('tl_undo', ['id' => $undoId]);
        $this->logger->info('Undone '.$undo['query']);

        if ($restored) {
            (new EditorDataContainer(self::TABLE, $restored))->invalidateCacheTags();
        }
    }

    /**
     * @param array<string, array<int, int|string>> $delete
     */
    private function collectChildren(string $table, int $id, array &$delete, int $depth): void
    {
        $ctables = $GLOBALS['TL_DCA'][$table]['config']['ctable'] ?? [];

        if (!\is_array($ctables) || $depth > self::MAX_DEPTH) {
            return;
        }

        foreach ($ctables as $ctable) {
            Controller::loadDataContainer($ctable);

            if ($GLOBALS['TL_DCA'][$ctable]['config']['doNotDeleteRecords'] ?? false) {
                continue;
            }

            $children = ($GLOBALS['TL_DCA'][$ctable]['config']['dynamicPtable'] ?? false)
                ? $this->connection->fetchFirstColumn("SELECT id FROM $ctable WHERE pid = ? AND ptable = ? ORDER BY id", [$id, $table])
                : $this->connection->fetchFirstColumn("SELECT id FROM $ctable WHERE pid = ? ORDER BY id", [$id]);

            foreach ($children as $child) {
                $delete[$ctable][] = (int) $child;
                $this->collectChildren($ctable, (int) $child, $delete, $depth + 1);
            }
        }
    }

    /**
     * Like the back end module "Wiederherstellen": only one's own deletions.
     *
     * @param array<string, mixed> $undo
     */
    private function canRestore(array $undo): bool
    {
        return $this->security->isGranted(ContaoCorePermissions::USER_CAN_ACCESS_MODULE, 'undo')
            && $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.'tl_undo', new ReadAction('tl_undo', $undo));
    }

    private function isGranted(DeleteAction|ReadAction $action): bool
    {
        return $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, $action);
    }
}
