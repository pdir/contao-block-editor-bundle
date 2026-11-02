<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Page;

use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\DataContainer;
use Contao\Versions;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Element\RecordWriter;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Routing\RouterInterface;

/**
 * Renames a page from its link in the navigation. Only the name can change, and it takes
 * the same path as in the back end: permissions, validation, callbacks and versioning.
 */
final class PageUpdater
{
    private const TABLE = PageInspector::TABLE;
    private const FIELD = PageInspector::TITLE;

    public function __construct(
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly PageInspector $inspector,
        private readonly RecordWriter $writer,
        private readonly RouterInterface $router,
        private readonly RequestStack $requestStack,
    ) {
    }

    /**
     * @return array<string, mixed>
     */
    public function rename(int $id, string $revision, string $title): array
    {
        $this->inspector->loadDca();
        $this->connection->beginTransaction();

        try {
            $this->doRename($id, $revision, $title);
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }

        return $this->inspector->describe($id) ?? throw new ApiException(404, 'Die Seite wurde nicht gefunden.');
    }

    private function doRename(int $id, string $revision, string $title): void
    {
        // Lock the record, so that the revision check and the update are atomic
        $row = $this->connection->fetchAssociative('SELECT * FROM tl_page WHERE id = ? FOR UPDATE', [$id]);

        if (false === $row || !$this->isGranted(new ReadAction(self::TABLE, $row))) {
            throw new ApiException(404, 'Die Seite wurde nicht gefunden.');
        }

        if (!$this->inspector->canEditTitle($row)) {
            throw new ApiException(403, 'Diese Seite darf nicht umbenannt werden.', ['field' => self::FIELD]);
        }

        if (!hash_equals(ElementInspector::revision($row), $revision)) {
            throw new ApiException(409, 'Die Seite wurde zwischenzeitlich geändert. Bitte die Seite neu laden.');
        }

        $dc = new EditorDataContainer(self::TABLE, $row);

        $this->writer->runRecordCallbacks(self::TABLE, 'onload_callback', $dc);
        $this->requestStack->getCurrentRequest()?->request->set('FORM_SUBMIT', self::TABLE);

        try {
            $validated = $this->writer->validateField(self::TABLE, self::FIELD, $title, $row, $dc);
        } catch (ApiException $exception) {
            if (422 === $exception->status) {
                throw new ApiException(422, 'Bitte die Eingaben prüfen.', ['errors' => [self::FIELD => $exception->getMessage()]]);
            }

            throw $exception;
        }

        if (!$validated['save']) {
            return;
        }

        $submit = $this->writer->runBeforeSubmitCallbacks(self::TABLE, [self::FIELD => $validated['value'], 'tstamp' => time()], $dc);

        // The voters get to see the new values
        if (!$this->isGranted(new UpdateAction(self::TABLE, $row, $submit))) {
            throw new ApiException(403, 'Diese Seite darf nicht umbenannt werden.', ['field' => self::FIELD]);
        }

        $versions = new Versions(self::TABLE, $id);
        $versions->setEditUrl($this->router->generate('contao_backend', ['do' => 'page', 'act' => 'edit', 'id' => $id]));
        $versions->initialize();

        $this->connection->update(
            'tl_page',
            array_combine(array_map($this->connection->quoteIdentifier(...), array_keys($submit)), $submit),
            ['id' => $id],
        );

        DataContainer::clearCurrentRecordCache($id, self::TABLE);

        $updated = $this->connection->fetchAssociative('SELECT * FROM tl_page WHERE id = ?', [$id]);

        \assert(\is_array($updated));

        $dc = new EditorDataContainer(self::TABLE, $updated);

        $this->writer->runRecordCallbacks(self::TABLE, 'onsubmit_callback', $dc);
        $dc->invalidateCacheTags();

        if ($this->writer->shouldVersion(self::TABLE, $submit)) {
            $versions->create();
        }
    }

    private function isGranted(ReadAction|UpdateAction $action): bool
    {
        return $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, $action);
    }
}
