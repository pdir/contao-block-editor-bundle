<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Controller;

use Contao\CoreBundle\Exception\AccessDeniedException;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Element\ElementUpdater;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
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
