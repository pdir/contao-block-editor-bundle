<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\CreateAction;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\System;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Adds a new element next to an existing one, or to an empty article. It follows DC_Table::create(): the default
 * values of the DCA, the voters decide on the type in this place (including the nesting
 * rules), then the oncreate callbacks run. Like the back end, only the types the voters
 * allow in this place are offered.
 */
final class ElementCreator
{
    private const TABLE = ElementInspector::TABLE;
    private const SORTING_STEP = 128;

    /** Replaced by the elements that nest others, kept for old content only. */
    private const HIDDEN_GROUPS = ['legacy'];

    public function __construct(
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly ElementInspector $inspector,
        private readonly LoggerInterface $logger,
    ) {
    }

    /**
     * The types that can be added next to an element, in the groups of the back end.
     *
     * @return list<array{label: string, types: list<array{type: string, label: string}>}>
     */
    public function types(int $targetId): array
    {
        $this->inspector->loadDca();

        return $this->typesIn($this->besideElement($targetId));
    }

    /**
     * The types that can be added to an article without elements.
     *
     * @return list<array{label: string, types: list<array{type: string, label: string}>}>
     */
    public function typesInArticle(int $articleId): array
    {
        $this->inspector->loadDca();

        return $this->typesIn($this->inArticle($articleId));
    }

    /**
     * Whether the user may add anything to the article at all: only then does the editor offer it.
     */
    public function canAddToArticle(int $articleId): bool
    {
        return $this->isGranted(new CreateAction(self::TABLE, ['pid' => $articleId, 'ptable' => 'tl_article']));
    }

    /**
     * @param array{pid: int, ptable: string} $target
     *
     * @return list<array{label: string, types: list<array{type: string, label: string}>}>
     */
    private function typesIn(array $target): array
    {
        $groups = [];

        foreach ($GLOBALS['TL_CTE'] ?? [] as $group => $types) {
            if (\in_array($group, self::HIDDEN_GROUPS, true) || !\is_array($types)) {
                continue;
            }

            $allowed = [];

            foreach (array_keys($types) as $type) {
                $type = (string) $type;

                if (isset($GLOBALS['TL_DCA'][self::TABLE]['palettes'][$type]) && $this->isGranted(new CreateAction(self::TABLE, ['pid' => $target['pid'], 'ptable' => $target['ptable'], 'type' => $type]))) {
                    $allowed[] = ['type' => $type, 'label' => ElementInspector::typeLabel($type)];
                }
            }

            if ($allowed) {
                $label = $GLOBALS['TL_LANG']['CTE'][$group] ?? null;
                $groups[] = ['label' => \is_string($label) ? $label : (string) $group, 'types' => $allowed];
            }
        }

        return $groups;
    }

    /**
     * @return array{element: array<string, mixed>, revisions: array<int, string>}
     */
    public function create(int $targetId, string $position, string $type): array
    {
        return $this->transactional(fn (): array => $this->doCreate($this->besideElement($targetId, true), $targetId, $position, $type));
    }

    /**
     * Adds the element at the end of an article, which has none so far as a rule.
     *
     * @return array{element: array<string, mixed>, revisions: array<int, string>}
     */
    public function createInArticle(int $articleId, string $type): array
    {
        return $this->transactional(fn (): array => $this->doCreate($this->inArticle($articleId, true), null, 'after', $type));
    }

    /**
     * @param \Closure(): array{element: array<string, mixed>, revisions: array<int, string>} $create
     *
     * @return array{element: array<string, mixed>, revisions: array<int, string>}
     */
    private function transactional(\Closure $create): array
    {
        $this->inspector->loadDca();
        $this->connection->beginTransaction();

        try {
            $result = $create();
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }

        return $result;
    }

    /**
     * @param array{pid: int, ptable: string} $target the parent of the new element
     *
     * @return array{element: array<string, mixed>, revisions: array<int, string>}
     */
    private function doCreate(array $target, int|null $targetId, string $position, string $type): array
    {
        if (!isset($GLOBALS['TL_DCA'][self::TABLE]['palettes'][$type]) || ($GLOBALS['TL_DCA'][self::TABLE]['config']['notCreatable'] ?? false)) {
            throw new ApiException(422, 'Dieses Element kann hier nicht eingefügt werden.');
        }

        $pid = $target['pid'];
        $ptable = $target['ptable'];

        /** @var array<int, int> $siblings */
        $siblings = array_map(intval(...), $this->connection->fetchAllKeyValue(
            'SELECT id, sorting FROM tl_content WHERE pid = ? AND ptable = ? ORDER BY sorting, id FOR UPDATE',
            [$pid, $ptable],
        ));

        $ids = array_keys($siblings);
        // Next to the element, or at the end of the article
        $index = null === $targetId ? \count($ids) : (int) array_search($targetId, $ids, true) + ('after' === $position ? 1 : 0);
        $sorting = ElementMover::sortingAt(array_values($siblings), $index);
        $renumber = null === $sorting;

        if ($renumber) {
            $sorting = ($index + 1) * self::SORTING_STEP;
        }

        $set = [...$this->defaults($target), 'pid' => $pid, 'ptable' => $ptable, 'type' => $type, 'sorting' => $sorting, 'tstamp' => time()];

        // The voters decide on the type in this place, as in the back end
        if (!$this->isGranted(new CreateAction(self::TABLE, $set))) {
            throw new ApiException(403, 'Dieses Element darf hier nicht eingefügt werden.');
        }

        $this->connection->insert('tl_content', array_combine(array_map($this->connection->quoteIdentifier(...), array_keys($set)), $set));
        $id = (int) $this->connection->lastInsertId();
        $changed = [];

        if ($renumber) {
            foreach ($ids as $place => $sibling) {
                $new = ($place + ($place >= $index ? 2 : 1)) * self::SORTING_STEP;

                if ($new !== $siblings[$sibling]) {
                    $this->connection->update('tl_content', ['sorting' => $new], ['id' => $sibling]);
                    $changed[] = $sibling;
                }
            }
        }

        $row = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?', [$id]);

        \assert(\is_array($row));

        $dc = new EditorDataContainer(self::TABLE, $row);

        foreach ($GLOBALS['TL_DCA'][self::TABLE]['config']['oncreate_callback'] ?? [] as $callback) {
            \is_array($callback)
                ? System::importStatic($callback[0])->{$callback[1]}(self::TABLE, $id, $set, $dc)
                : $callback(self::TABLE, $id, $set, $dc);
        }

        $dc->invalidateCacheTags();

        $this->logger->info(\sprintf('A new entry "%s.id=%d" has been created', self::TABLE, $id));

        $element = $this->inspector->getElements([$id])[$id] ?? throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        $revisions = [];

        if ($changed) {
            foreach ($this->connection->fetchAllAssociative('SELECT * FROM tl_content WHERE id IN (?)', [$changed], [ArrayParameterType::INTEGER]) as $changedRow) {
                $revisions[(int) $changedRow['id']] = ElementInspector::revision($changedRow);
            }
        }

        return ['element' => $element, 'revisions' => $revisions];
    }

    /**
     * The parent of the element next to which a new one goes.
     *
     * @return array{pid: int, ptable: string}
     */
    private function besideElement(int $targetId, bool $lock = false): array
    {
        $target = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?'.($lock ? ' FOR UPDATE' : ''), [$targetId]);

        if (false === $target || !\in_array($target['ptable'], ElementInspector::supportedPtables(), true) || !$this->isGranted(new ReadAction(self::TABLE, $target))) {
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }

        return ['pid' => (int) $target['pid'], 'ptable' => (string) $target['ptable']];
    }

    /**
     * @return array{pid: int, ptable: string}
     */
    private function inArticle(int $articleId, bool $lock = false): array
    {
        $article = $this->connection->fetchAssociative('SELECT * FROM tl_article WHERE id = ?'.($lock ? ' FOR UPDATE' : ''), [$articleId]);

        if (false === $article || !\in_array('tl_article', ElementInspector::supportedPtables(), true) || !$this->security->isGranted(ContaoCorePermissions::DC_PREFIX.'tl_article', new ReadAction('tl_article', $article))) {
            throw new ApiException(404, 'Der Artikel wurde nicht gefunden.');
        }

        return ['pid' => $articleId, 'ptable' => 'tl_article'];
    }

    /**
     * The default values of the DCA, for the columns of the table.
     *
     * @param array{pid: int, ptable: string} $target
     *
     * @return array<string, mixed>
     */
    private function defaults(array $target): array
    {
        $dc = new EditorDataContainer(self::TABLE, ['id' => 0, 'pid' => $target['pid'], 'ptable' => $target['ptable']]);
        $set = [];

        foreach ($GLOBALS['TL_DCA'][self::TABLE]['fields'] ?? [] as $field => $config) {
            if (!\is_array($config) || !\array_key_exists('default', $config) || !isset($config['sql'])) {
                continue;
            }

            $default = $config['default'] instanceof \Closure ? $config['default']($dc) : $config['default'];
            $set[(string) $field] = match (true) {
                \is_array($default) => serialize($default),
                \is_bool($default) => $default ? '1' : '',
                default => $default,
            };
        }

        return $set;
    }

    private function isGranted(CreateAction|ReadAction $action): bool
    {
        return $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, $action);
    }
}
