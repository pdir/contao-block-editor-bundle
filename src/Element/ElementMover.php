<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\DataContainer;
use Contao\System;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Moves an element next to another one, also to another parent. It follows
 * DC_Table::cut(): the voters see the new position (including the nesting rules),
 * oncut callbacks run and the cache tags of both parents are invalidated.
 */
final class ElementMover
{
    public const POSITIONS = ['before', 'after'];

    private const TABLE = ElementInspector::TABLE;
    private const SORTING_STEP = 128;
    private const MAX_DEPTH = 100;

    public function __construct(
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly ElementInspector $inspector,
    ) {
    }

    /**
     * @return array{revisions: array<int, string>}
     */
    public function move(int $id, string $revision, int $targetId, string $position): array
    {
        if ($id === $targetId) {
            throw new ApiException(422, 'Ein Element kann nicht neben sich selbst verschoben werden.');
        }

        $this->inspector->loadDca();
        $this->connection->beginTransaction();

        try {
            $result = $this->doMove($id, $revision, $targetId, $position);
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }

        return $result;
    }

    /**
     * Where the moved element goes between its new neighbours.
     *
     * @param list<int> $sortings The sortings of the siblings, in order, without the moved element
     *
     * @return int|null null if there is no gap left and the siblings have to be renumbered
     */
    public static function sortingAt(array $sortings, int $index): int|null
    {
        $previous = $sortings[$index - 1] ?? 0;
        $next = $sortings[$index] ?? null;

        if (null === $next) {
            return $previous + self::SORTING_STEP;
        }

        $sorting = (int) (($previous + $next) / 2);

        return $sorting > $previous && $sorting < $next ? $sorting : null;
    }

    /**
     * @return array{revisions: array<int, string>}
     */
    private function doMove(int $id, string $revision, int $targetId, string $position): array
    {
        $row = $this->lock($id);
        $target = $this->lock($targetId);

        $this->denyUnlessGranted(new ReadAction(self::TABLE, $row));
        $this->denyUnlessGranted(new UpdateAction(self::TABLE, $row));
        $this->denyUnlessGranted(new ReadAction(self::TABLE, $target));

        if (!hash_equals(ElementInspector::revision($row), $revision)) {
            throw new ApiException(409, 'Das Element wurde zwischenzeitlich geändert. Bitte die Seite neu laden.');
        }

        $this->assertNotInsideOfItself($id, $target);

        $pid = (int) $target['pid'];
        $ptable = (string) $target['ptable'];

        /** @var array<int, int> $siblings */
        $siblings = array_map(intval(...), $this->connection->fetchAllKeyValue(
            'SELECT id, sorting FROM tl_content WHERE pid = ? AND ptable = ? AND id != ? ORDER BY sorting, id FOR UPDATE',
            [$pid, $ptable, $id],
        ));

        $ids = array_keys($siblings);
        $index = (int) array_search($targetId, $ids, true) + ('after' === $position ? 1 : 0);
        $samePlace = (int) $row['pid'] === $pid && (string) $row['ptable'] === $ptable;

        if ($samePlace && $this->isAlreadyThere($row, $siblings, $index)) {
            return ['revisions' => [$id => $revision]];
        }

        $sorting = self::sortingAt(array_values($siblings), $index);
        $renumber = null === $sorting;

        if ($renumber) {
            $sorting = ($index + 1) * self::SORTING_STEP;
        }

        // The voters get to see the new position, e.g. to deny a foreign page or invalid nesting
        $this->denyUnlessGranted(new UpdateAction(self::TABLE, $row, ['pid' => $pid, 'ptable' => $ptable, 'sorting' => $sorting]));

        $this->runCallbacks('onload_callback', new EditorDataContainer(self::TABLE, $row));

        // Invalidates the tags of the old parent, which can't be determined afterwards
        (new EditorDataContainer(self::TABLE, $row))->invalidateCacheTags();

        $this->connection->update('tl_content', ['pid' => $pid, 'ptable' => $ptable, 'sorting' => $sorting, 'tstamp' => time()], ['id' => $id]);

        $changed = [$id];

        if ($renumber) {
            foreach ($ids as $place => $sibling) {
                $new = ($place + ($place >= $index ? 2 : 1)) * self::SORTING_STEP;

                if ($new !== $siblings[$sibling]) {
                    $this->connection->update('tl_content', ['sorting' => $new], ['id' => $sibling]);
                    $changed[] = $sibling;
                }
            }
        }

        DataContainer::clearCurrentRecordCache($id, self::TABLE);

        $moved = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?', [$id]);

        \assert(\is_array($moved));

        $dc = new EditorDataContainer(self::TABLE, $moved);

        $this->runCallbacks('oncut_callback', $dc);
        $dc->invalidateCacheTags();

        // Callbacks can change records too, so read the final state. All siblings of the
        // new position are locked, so no other request can invalidate these revisions.
        $revisions = [];

        foreach ($this->connection->fetchAllAssociative('SELECT * FROM tl_content WHERE id IN (?)', [$changed], [ArrayParameterType::INTEGER]) as $changedRow) {
            $revisions[(int) $changedRow['id']] = ElementInspector::revision($changedRow);
        }

        return ['revisions' => $revisions];
    }

    /**
     * @param array<string, mixed> $row
     * @param array<int, int>      $siblings
     */
    private function isAlreadyThere(array $row, array $siblings, int $index): bool
    {
        $sortings = array_values($siblings);
        $sorting = (int) $row['sorting'];

        return ($sortings[$index - 1] ?? \PHP_INT_MIN) <= $sorting && $sorting <= ($sortings[$index] ?? \PHP_INT_MAX)
            && ($sortings[$index - 1] ?? null) !== $sorting && ($sortings[$index] ?? null) !== $sorting;
    }

    /**
     * @return array<string, mixed>
     */
    private function lock(int $id): array
    {
        $row = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ? FOR UPDATE', [$id]);

        if (false === $row || !\in_array($row['ptable'], ElementInspector::SUPPORTED_PTABLES, true)) {
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }

        return $row;
    }

    /**
     * A nested element's parent would otherwise end up inside of its own child.
     *
     * @param array<string, mixed> $target
     */
    private function assertNotInsideOfItself(int $id, array $target): void
    {
        for ($depth = 0; 'tl_content' === $target['ptable']; ++$depth) {
            if ((int) $target['pid'] === $id) {
                throw new ApiException(422, 'Ein Element kann nicht in sich selbst verschoben werden.');
            }

            $target = $this->connection->fetchAssociative('SELECT pid, ptable FROM tl_content WHERE id = ?', [$target['pid']]);

            if (false === $target || $depth >= self::MAX_DEPTH) {
                throw new ApiException(422, 'Das Ziel ist ungültig.');
            }
        }
    }

    private function denyUnlessGranted(ReadAction|UpdateAction $action): void
    {
        if (!$this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, $action)) {
            // Don't reveal whether the element exists
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }
    }

    private function runCallbacks(string $key, EditorDataContainer $dc): void
    {
        foreach ($GLOBALS['TL_DCA'][self::TABLE]['config'][$key] ?? [] as $callback) {
            \is_array($callback)
                ? System::importStatic($callback[0])->{$callback[1]}($dc)
                : $callback($dc);
        }
    }
}
