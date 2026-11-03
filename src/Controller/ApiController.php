<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Controller;

use Contao\CoreBundle\Exception\AccessDeniedException;
use Pdir\ContaoBlockEditorBundle\Element\ElementCreator;
use Pdir\ContaoBlockEditorBundle\Element\ElementDeleter;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Element\ElementMover;
use Pdir\ContaoBlockEditorBundle\Element\ElementUpdater;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Pdir\ContaoBlockEditorBundle\Page\PageInspector;
use Pdir\ContaoBlockEditorBundle\Page\PageUpdater;
use Pdir\ContaoBlockEditorBundle\Record\ReaderRecord;
use Pdir\ContaoBlockEditorBundle\Record\RecordUpdater;
use Pdir\ContaoBlockEditorBundle\Security\RequestGuard;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Core\Exception\AccessDeniedException as SymfonyAccessDeniedException;

#[Route('%contao.backend.route_prefix%/block-editor/api', defaults: ['_scope' => 'backend', '_store_referrer' => false])]
final class ApiController
{
    public function __construct(
        private readonly RequestGuard $guard,
        private readonly ElementInspector $inspector,
        private readonly ElementUpdater $updater,
        private readonly ElementMover $mover,
        private readonly ElementCreator $creator,
        private readonly ElementDeleter $deleter,
        private readonly PageInspector $pages,
        private readonly PageUpdater $pageUpdater,
        private readonly ReaderRecord $records,
        private readonly RecordUpdater $recordUpdater,
    ) {
    }

    #[Route('/elements', name: 'pdir_block_editor_api_elements', methods: ['GET'])]
    public function elements(Request $request): Response
    {
        return $this->handle(function () use ($request): Response {
            $this->guard->assertCanRead($request);

            $ids = self::parseIds((string) $request->query->get('ids', ''));

            return $this->json(['elements' => (object) ($ids ? $this->inspector->getElements($ids) : [])]);
        });
    }

    #[Route('/schema', name: 'pdir_block_editor_api_schema', methods: ['GET'])]
    public function schema(Request $request): Response
    {
        return $this->handle(function () use ($request): Response {
            $this->guard->assertCanRead($request);

            $types = array_values(array_unique(array_filter(
                explode(',', (string) $request->query->get('types', '')),
                static fn (string $type): bool => 1 === preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $type),
            )));

            $response = $this->json(['types' => (object) $this->inspector->getSchema($types)]);

            // The schema depends on the user's permissions, so it may only live in their
            // browser cache and must be revalidated.
            $response->headers->set('Cache-Control', 'private, no-cache');
            $response->setEtag(hash('xxh128', (string) $response->getContent()));
            $response->isNotModified($request);

            return $response;
        });
    }

    /**
     * The types that can be added next to an element.
     */
    #[Route('/elements/{id}/types', name: 'pdir_block_editor_api_types', requirements: ['id' => '[1-9]\d{0,9}'], methods: ['GET'])]
    public function types(Request $request, int $id): Response
    {
        return $this->handle(function () use ($request, $id): Response {
            $this->guard->assertCanRead($request);

            return $this->json(['groups' => $this->creator->types($id)]);
        });
    }

    #[Route('/elements', name: 'pdir_block_editor_api_create', methods: ['POST'])]
    public function create(Request $request): Response
    {
        return $this->handle(function () use ($request): Response {
            $this->guard->assertCanWrite($request);

            $data = $this->guard->decodeJsonBody($request);
            $target = $data['target'] ?? null;
            $position = $data['position'] ?? null;
            $type = $data['type'] ?? null;

            if (!\is_int($target) || $target < 1 || !\in_array($position, ElementMover::POSITIONS, true) || !\is_string($type) || 1 !== preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $type)) {
                throw new ApiException(400, 'Ungültige Anfrage.');
            }

            return $this->json($this->creator->create($target, $position, $type), 201);
        });
    }

    #[Route('/elements/{id}', name: 'pdir_block_editor_api_update', requirements: ['id' => '[1-9]\d{0,9}'], methods: ['PATCH'])]
    public function update(Request $request, int $id): Response
    {
        return $this->handle(function () use ($request, $id): Response {
            $this->guard->assertCanWrite($request);

            $data = $this->guard->decodeJsonBody($request);

            if (!\is_string($data['revision'] ?? null) || !\is_array($data['values'] ?? null) || array_is_list($data['values'])) {
                throw new ApiException(400, 'Ungültige Anfrage.');
            }

            return $this->json($this->updater->update($id, $data['revision'], $data['values']));
        });
    }

    #[Route('/elements/{id}', name: 'pdir_block_editor_api_delete', requirements: ['id' => '[1-9]\d{0,9}'], methods: ['DELETE'])]
    public function delete(Request $request, int $id): Response
    {
        return $this->handle(function () use ($request, $id): Response {
            $this->guard->assertCanWrite($request);

            $data = $this->guard->decodeJsonBody($request);

            if (!\is_string($data['revision'] ?? null)) {
                throw new ApiException(400, 'Ungültige Anfrage.');
            }

            return $this->json($this->deleter->delete($id, $data['revision']));
        });
    }

    /**
     * Restores what was deleted, from Contao's tl_undo.
     */
    #[Route('/undo/{id}', name: 'pdir_block_editor_api_undo', requirements: ['id' => '[1-9]\d{0,9}'], methods: ['POST'])]
    public function undo(Request $request, int $id): Response
    {
        return $this->handle(function () use ($request, $id): Response {
            $this->guard->assertCanWrite($request);
            $this->deleter->restore($id);

            return $this->json(['restored' => true]);
        });
    }

    #[Route('/elements/{id}/position', name: 'pdir_block_editor_api_move', requirements: ['id' => '[1-9]\d{0,9}'], methods: ['PATCH'])]
    public function move(Request $request, int $id): Response
    {
        return $this->handle(function () use ($request, $id): Response {
            $this->guard->assertCanWrite($request);

            $data = $this->guard->decodeJsonBody($request);
            $target = $data['target'] ?? null;
            $position = $data['position'] ?? null;

            if (!\is_string($data['revision'] ?? null) || !\is_int($target) || $target < 1 || !\in_array($position, ElementMover::POSITIONS, true)) {
                throw new ApiException(400, 'Ungültige Anfrage.');
            }

            return $this->json($this->mover->move($id, $data['revision'], $target, $position));
        });
    }

    /**
     * The pages behind the links of a navigation, so that their names can be edited.
     */
    #[Route('/pages', name: 'pdir_block_editor_api_pages', methods: ['GET'])]
    public function pages(Request $request): Response
    {
        return $this->handle(function () use ($request): Response {
            $this->guard->assertCanRead($request);

            $urls = $request->query->all('url');

            if (!array_is_list($urls) || \count($urls) > PageInspector::MAX_URLS || array_filter($urls, static fn ($url): bool => !\is_string($url) || \strlen($url) > 2048)) {
                throw new ApiException(400, 'Ungültige Adressen.');
            }

            return $this->json(['pages' => (object) $this->pages->resolve(array_values(array_unique($urls)), $request)]);
        });
    }

    #[Route('/pages/{id}', name: 'pdir_block_editor_api_page_update', requirements: ['id' => '[1-9]\d{0,9}'], methods: ['PATCH'])]
    public function updatePage(Request $request, int $id): Response
    {
        return $this->handle(function () use ($request, $id): Response {
            $this->guard->assertCanWrite($request);

            $data = $this->guard->decodeJsonBody($request);

            if (!\is_string($data['revision'] ?? null) || !\is_string($data['title'] ?? null)) {
                throw new ApiException(400, 'Ungültige Anfrage.');
            }

            return $this->json($this->pageUpdater->rename($id, $data['revision'], $data['title']));
        });
    }

    /**
     * The news or event of a reader page, whose headline is a field of the record, or the
     * meta data of the page.
     */
    #[Route('/records/{table}/{id}', name: 'pdir_block_editor_api_record', requirements: ['table' => 'tl_news|tl_calendar_events|tl_page', 'id' => '[1-9]\d{0,9}'], methods: ['GET'])]
    public function record(Request $request, string $table, int $id): Response
    {
        return $this->handle(function () use ($request, $table, $id): Response {
            $this->guard->assertCanRead($request);

            return $this->json($this->records->describe($table, $id) ?? throw new ApiException(404, 'Der Eintrag wurde nicht gefunden.'));
        });
    }

    #[Route('/records/{table}/{id}', name: 'pdir_block_editor_api_record_update', requirements: ['table' => 'tl_news|tl_calendar_events|tl_page', 'id' => '[1-9]\d{0,9}'], methods: ['PATCH'])]
    public function updateRecord(Request $request, string $table, int $id): Response
    {
        return $this->handle(function () use ($request, $table, $id): Response {
            $this->guard->assertCanWrite($request);

            $data = $this->guard->decodeJsonBody($request);

            if (!\is_string($data['revision'] ?? null) || !\is_array($data['values'] ?? null) || array_is_list($data['values'])) {
                throw new ApiException(400, 'Ungültige Anfrage.');
            }

            return $this->json($this->recordUpdater->update($table, $id, $data['revision'], $data['values']));
        });
    }

    /**
     * @return list<int>
     */
    private static function parseIds(string $ids): array
    {
        if ('' === $ids) {
            return [];
        }

        if (!preg_match('/^[1-9]\d{0,9}(,[1-9]\d{0,9})*$/', $ids)) {
            throw new ApiException(400, 'Ungültige Element-IDs.');
        }

        $parsed = array_values(array_unique(array_map(intval(...), explode(',', $ids))));

        if (\count($parsed) > ElementInspector::MAX_IDS) {
            throw new ApiException(400, 'Zu viele Elemente angefragt.');
        }

        return $parsed;
    }

    private function json(mixed $data, int $status = 200): JsonResponse
    {
        $response = new JsonResponse($data, $status);
        $response->headers->set('Cache-Control', 'private, no-store');
        $response->headers->set('X-Content-Type-Options', 'nosniff');

        return $response;
    }

    /**
     * @param callable(): Response $action
     */
    private function handle(callable $action): Response
    {
        try {
            return $action();
        } catch (ApiException $exception) {
            return $this->json(['error' => $exception->getMessage(), ...$exception->details], $exception->status);
        } catch (AccessDeniedException|SymfonyAccessDeniedException) {
            return $this->json(['error' => 'Keine Berechtigung.'], 403);
        }
    }
}
