<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Controller;

use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Routing\ContentUrlGenerator;
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
    ) {
    }

    public function __invoke(Request $request): Response
    {
        if (!$this->security->isGranted('ROLE_USER')) {
            throw new AccessDeniedHttpException();
        }

        $this->framework->initialize();

        $pageId = $request->query->getInt('id');
        $page = $this->framework->getAdapter(PageModel::class)->findById($pageId);

        if (!$page instanceof PageModel) {
            throw new NotFoundHttpException();
        }

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
            'assets' => array_combine(
                ['shell_css', 'shell_js', 'frame_js'],
                array_map(fn (string $file): string => $this->assets->url($file, $request->getBasePath()), ['shell.css', 'shell.js', 'frame.js']),
            ),
        ];

        if (!$this->assets->isDeployed()) {
            $parameters['stale_assets'] = true;

            return $this->render($parameters);
        }

        // The editor relies on same-origin access. Pages on another domain must be edited
        // on that domain, where the user has their own session.
        if ('' !== $host && strtolower($host) !== strtolower($request->getHost())) {
            $parameters['other_domain_url'] = ($parts['scheme'] ?? 'https').'://'.$host.$request->getBaseUrl().$request->getPathInfo().'?id='.$pageId;
        } elseif ('' === $this->previewScript) {
            $parameters['no_preview'] = true;
        } else {
            $parameters['frame_url'] = $request->getBasePath().$this->previewScript.($parts['path'] ?? '/').'?'.EditorFrameListener::QUERY_PARAMETER.'=1';
            $parameters['preview_url'] = $request->getBasePath().$this->previewScript;
            $parameters['token'] = $this->csrfTokenManager->getToken($this->csrfTokenName)->getValue();
        }

        return $this->render($parameters);
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
