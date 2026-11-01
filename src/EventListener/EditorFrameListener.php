<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\EventListener;

use Contao\ContentModel;
use Contao\CoreBundle\DependencyInjection\Attribute\AsHook;
use Contao\CoreBundle\Security\Authentication\Token\TokenChecker;
use Pdir\ContaoBlockEditorBundle\Element\EditorAssets;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ResponseEvent;

/**
 * Prepares the page in the editor iframe. Regular visitors never get any of this:
 * it requires the preview entry point, a logged-in back end user and the marker
 * query parameter. Such a response is never stored in any cache.
 */
final class EditorFrameListener
{
    public const QUERY_PARAMETER = '_block_editor';

    public function __construct(
        private readonly RequestStack $requestStack,
        private readonly TokenChecker $tokenChecker,
        private readonly EditorAssets $assets,
    ) {
    }

    #[AsHook('getContentElement')]
    public function markElement(ContentModel $model, string $buffer): string
    {
        // Elements created on the fly (e.g. nested in Twig) have no record to edit
        if ((int) $model->id < 1 || !$this->isEditorRequest()) {
            return $buffer;
        }

        return self::addMarker($buffer, (int) $model->id);
    }

    #[AsEventListener(priority: -200)]
    public function onResponse(ResponseEvent $event): void
    {
        if (!$event->isMainRequest() || !$this->isEditorRequest()) {
            return;
        }

        $response = $event->getResponse();

        // Never let a page with editor markup end up in a shared or browser cache
        $response->headers->set('Cache-Control', 'private, no-store');
        $response->headers->remove('Expires');

        if (!$response->isSuccessful() || !str_contains((string) $response->headers->get('Content-Type', 'text/html'), 'text/html')) {
            return;
        }

        $this->injectAssets($response, $event->getRequest()->getBasePath());
    }

    /**
     * Adds the marker to the root tag of a rendered element, skipping leading comments
     * such as the indexer markers. The ID is an integer, so no escaping is required.
     * If an inner element (alias) is marked already, the outer element is left alone.
     */
    public static function addMarker(string $buffer, int $id): string
    {
        if (!preg_match('/^\s*(?:<!--.*?-->\s*)*<[a-zA-Z][a-zA-Z0-9-]*/s', $buffer, $matches)) {
            return $buffer;
        }

        $offset = \strlen($matches[0]);
        $rootEnd = strpos($buffer, '>', $offset);

        if (false !== $rootEnd && str_contains(substr($buffer, $offset, $rootEnd - $offset), 'data-be-id=')) {
            return $buffer;
        }

        return substr_replace($buffer, ' data-be-id="'.$id.'"', $offset, 0);
    }

    private function isEditorRequest(): bool
    {
        $request = $this->requestStack->getMainRequest();

        return $request
            && $request->attributes->getBoolean('_preview')
            && '1' === $request->query->get(self::QUERY_PARAMETER)
            && $this->tokenChecker->hasBackendUser();
    }

    private function injectAssets(Response $response, string $basePath): void
    {
        $content = (string) $response->getContent();
        $position = strripos($content, '</body>');

        if (false === $position) {
            return;
        }

        $nonce = $this->allowAssetsInCsp($response);
        $nonceAttribute = null === $nonce ? '' : ' nonce="'.$nonce.'"';
        $url = fn (string $file): string => htmlspecialchars($this->assets->url($file, $basePath), ENT_QUOTES);

        $tags = '<link rel="stylesheet" href="'.$url('frame.css').'"'.$nonceAttribute.'>'
            .'<script type="module" src="'.$url('frame.js').'"'.$nonceAttribute.'></script>';

        $response->setContent(substr_replace($content, $tags, $position, 0));
    }

    /**
     * A page may send its own Content Security Policy. Reuse its nonce if there is one,
     * otherwise allow same-origin scripts and styles for this response only.
     */
    private function allowAssetsInCsp(Response $response): string|null
    {
        $header = $response->headers->get('Content-Security-Policy');

        if (!\is_string($header) || '' === $header) {
            return null;
        }

        if (preg_match("/script-src[^;]*'nonce-([A-Za-z0-9+\/=_-]+)'/", $header, $matches)) {
            return $matches[1];
        }

        foreach (['script-src', 'style-src'] as $directive) {
            $header = preg_replace_callback(
                '/(^|;\s*)'.$directive.'\b([^;]*)/',
                static fn (array $match): string => str_contains($match[2], "'self'") ? $match[0] : $match[1].$directive." 'self'".$match[2],
                $header,
            ) ?? $header;
        }

        $response->headers->set('Content-Security-Policy', $header);

        return null;
    }
}
