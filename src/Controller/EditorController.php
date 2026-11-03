<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Controller;

use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Routing\ContentUrlGenerator;
use Contao\CoreBundle\Security\Authentication\FrontendPreviewAuthenticator;
use Contao\CoreBundle\Security\Authentication\Token\TokenChecker;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\PageModel;
use Pdir\ContaoBlockEditorBundle\Element\EditorAssets;
use Pdir\ContaoBlockEditorBundle\EventListener\EditorFrameListener;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Routing\Exception\ExceptionInterface as RoutingException;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Routing\RouterInterface;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;
use Twig\Environment;

/**
 * Renders the editor shell. It takes a page ID, never a URL, so it cannot be abused
 * to frame or redirect to arbitrary targets.
 */
#[Route('%contao.backend.route_prefix%/block-editor', name: 'pdir_block_editor', defaults: ['_scope' => 'backend'], methods: ['GET'])]
final class EditorController
{
    public function __construct(
        private readonly ContaoFramework $framework,
        private readonly Security $security,
        private readonly ContentUrlGenerator $contentUrlGenerator,
        private readonly Environment $twig,
        private readonly CsrfTokenManagerInterface $csrfTokenManager,
        private readonly string $csrfTokenName,
        private readonly string $previewScript,
        private readonly EditorAssets $assets,
        private readonly TokenChecker $tokenChecker,
        private readonly RouterInterface $router,
    ) {
    }

    public function __invoke(Request $request): Response
    {
        if (!$this->security->isGranted('ROLE_USER')) {
            throw new AccessDeniedHttpException();
        }

        $this->framework->initialize();

        $page = $this->resolvePage($request->query->getInt('id'), $request->getHost());

        if (!$page instanceof PageModel) {
            throw new NotFoundHttpException();
        }

        $pageId = (int) $page->id;

        if (
            !$this->security->isGranted(ContaoCorePermissions::USER_CAN_ACCESS_PAGE, $pageId)
            || !$this->security->isGranted(ContaoCorePermissions::USER_CAN_EDIT_ARTICLES, $pageId)
        ) {
            throw new AccessDeniedHttpException();
        }

        try {
            $url = $this->contentUrlGenerator->generate($page, [], UrlGeneratorInterface::ABSOLUTE_URL);
        } catch (RoutingException) {
            throw new NotFoundHttpException('This page type has no URL.');
        }

        $parts = parse_url($url);
        $host = \is_array($parts) ? ($parts['host'] ?? '') : '';
        $parameters = [
            'title' => (string) $page->title,
            'extension_scripts' => $this->assets->extensionUrls($request->getBasePath()),
            // "rich-editor.js" as "rich_editor_js" in the template
            'assets' => array_combine(
                array_map(static fn (string $file): string => str_replace(['-', '.'], '_', $file), EditorAssets::FILES),
                array_map(fn (string $file): string => $this->assets->url($file, $request->getBasePath()), EditorAssets::FILES),
            ),
        ];

        if (!$this->assets->isDeployed()) {
            $parameters['stale_assets'] = true;

            return $this->render($parameters);
        }

        // The editor relies on same-origin access. Pages on another domain must be edited
        // on that domain, where the user has their own session.
        if ('' !== $host && strtolower($host) !== strtolower($request->getHost())) {
            $parameters['other_domain_url'] = ($parts['scheme'] ?? 'https').'://'.$host.$request->getBaseUrl().$request->getPathInfo().'?'.http_build_query(['id' => $pageId, 'element' => $request->query->getInt('element') ?: null]);
        } elseif ('' === $this->previewScript) {
            $parameters['no_preview'] = true;
        } else {
            $parameters['frame_url'] = $request->getBasePath().$this->previewScript.($parts['path'] ?? '/').'?'.EditorFrameListener::QUERY_PARAMETER.'=1';
            $parameters['preview_url'] = $request->getBasePath().$this->previewScript;
            $parameters['token'] = $this->csrfTokenManager->getToken($this->csrfTokenName)->getValue();
            $parameters['preview_options'] = $this->previewOptions($request, $parameters['token']);
        }

        return $this->render($parameters);
    }

    /**
     * What the preview toolbar of Contao offers, with the same permissions. Contao's own
     * endpoint (contao_backend_switch) applies the changes, so its checks stay in force.
     *
     * @return array{switch_url: string, share_url: string|null, can_switch_member: bool, member: string, show_unpublished: bool}
     */
    private function previewOptions(Request $request, string $token): array
    {
        $shareUrl = null;

        if ($this->security->isGranted(ContaoCorePermissions::USER_CAN_ACCESS_MODULE, 'preview_link')) {
            // The shell adds the address of the page and whether unpublished elements show
            $shareUrl = $this->router->generate('contao_backend', ['do' => 'preview_link', 'act' => 'create', 'rt' => $token, 'nb' => '1']);
        }

        // TokenChecker::isPreviewMode() only answers inside the preview, so read the session
        $preview = $request->hasPreviousSession() ? $request->getSession()->get(FrontendPreviewAuthenticator::SESSION_NAME) : null;

        return [
            'switch_url' => $this->router->generate('contao_backend_switch'),
            'share_url' => $shareUrl,
            'can_switch_member' => $this->security->isGranted('ROLE_ALLOWED_TO_SWITCH_MEMBER'),
            'member' => (string) $this->tokenChecker->getFrontendUsername(),
            'show_unpublished' => \is_array($preview) && !empty($preview['showUnpublished']),
        ];
    }

    /**
     * A root page has no content of its own, so it stands for its start page, like in the
     * front end. Without an ID, the editor opens the start page of the current domain.
     */
    private function resolvePage(int $id, string $host): PageModel|null
    {
        $pages = $this->framework->getAdapter(PageModel::class);
        $page = $id ? $pages->findById($id) : ($pages->findPublishedFallbackByHostname($host, ['fallbackToEmpty' => true]) ?? $pages->findPublishedRootPages()?->first());

        if ($page instanceof PageModel && 'root' === $page->type) {
            return $pages->findFirstPublishedRegularByPid($page->id);
        }

        return $page instanceof PageModel ? $page : null;
    }

    /**
     * @param array<string, mixed> $parameters
     */
    private function render(array $parameters): Response
    {
        $response = new Response($this->twig->render('@ContaoBlockEditor/editor.html.twig', $parameters));
        $response->headers->set('Cache-Control', 'private, no-store');
        $response->headers->set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        $response->headers->set('Referrer-Policy', 'same-origin');
        $response->headers->set('X-Content-Type-Options', 'nosniff');

        return $response;
    }
}
