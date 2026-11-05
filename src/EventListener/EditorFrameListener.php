<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\EventListener;

use Contao\ContentModel;
use Contao\CoreBundle\DependencyInjection\Attribute\AsHook;
use Contao\CoreBundle\Security\Authentication\Token\TokenChecker;
use Contao\PageModel;
use Pdir\ContaoBlockEditorBundle\Element\EditorAssets;
use Pdir\ContaoBlockEditorBundle\Record\ReaderRecord;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\Request;
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
        private readonly ReaderRecord $records,
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

        if ($response->isRedirect() && \is_string($location = $response->headers->get('Location'))) {
            $response->headers->set('Location', self::keepEditorInRedirect($location, $event->getRequest()));

            return;
        }

        if (!$response->isSuccessful() || !str_contains((string) $response->headers->get('Content-Type', 'text/html'), 'text/html')) {
            return;
        }

        $this->injectAssets($response, $event->getRequest());
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

    /**
     * A forward page would otherwise lead out of the editor. Targets on other hosts
     * and relative ones stay as they are: the frame can't show the former anyway.
     */
    public static function keepEditorInRedirect(string $location, Request $request): string
    {
        $parts = parse_url($location);

        if (!\is_array($parts) || !str_starts_with($parts['path'] ?? '/', '/') || (isset($parts['host']) && strtolower($parts['host']) !== strtolower($request->getHost()))) {
            return $location;
        }

        $path = $parts['path'] ?? '/';
        $preview = $request->getBaseUrl();
        $base = $request->getBasePath();

        if ($path !== $preview && !str_starts_with($path, $preview.'/')) {
            $path = $preview.('' !== $base && str_starts_with($path, $base.'/') ? substr($path, \strlen($base)) : $path);
        }

        $query = (string) ($parts['query'] ?? '');

        if (!preg_match('/(^|&)'.self::QUERY_PARAMETER.'=/', $query)) {
            $query .= ('' === $query ? '' : '&').self::QUERY_PARAMETER.'=1';
        }

        $origin = isset($parts['host']) ? (isset($parts['scheme']) ? $parts['scheme'].':' : '').'//'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '') : '';

        return $origin.$path.'?'.$query.(isset($parts['fragment']) ? '#'.$parts['fragment'] : '');
    }

    public function isEditorRequest(): bool
    {
        $request = $this->requestStack->getMainRequest();

        return $request
            && $request->attributes->getBoolean('_preview')
            && '1' === $request->query->get(self::QUERY_PARAMETER)
            && $this->tokenChecker->hasBackendUser();
    }

    private function injectAssets(Response $response, Request $request): void
    {
        $content = (string) $response->getContent();
        $position = strripos($content, '</body>');

        if (false === $position) {
            return;
        }

        $nonce = $this->allowAssetsInCsp($response);
        $nonceAttribute = null === $nonce ? '' : ' nonce="'.$nonce.'"';
        $url = fn (string $file): string => htmlspecialchars($this->assets->url($file, $request->getBasePath()), ENT_QUOTES);
        $page = $request->attributes->get('pageModel');
        $attributes = ' data-cbe-base="'.htmlspecialchars($request->getBasePath(), ENT_QUOTES).'" data-cbe-preview="'.htmlspecialchars($request->getBaseUrl(), ENT_QUOTES).'" data-cbe-rich-text="'.$url('rich-text.js').'"';

        if ($page instanceof PageModel) {
            $attributes .= ' data-cbe-page-id="'.(int) $page->id.'" data-cbe-page-title="'.htmlspecialchars(html_entity_decode((string) ($page->pageTitle ?: $page->title), ENT_QUOTES), ENT_QUOTES).'"';
        }

        // The news or event of a reader module, whose headline is no content element
        if ($record = $this->records->find($request, $content)) {
            $attributes .= ' data-cbe-record="'.$record['table'].'.'.$record['id'].'" data-cbe-record-scope="'.$record['scope'].'"';
        }

        $tags = '<link rel="stylesheet" href="'.$url('frame.css').'"'.$nonceAttribute.'>';

        foreach ($this->assets->extensionUrls($request->getBasePath()) as $extension) {
            $tags .= '<script type="module" src="'.htmlspecialchars($extension, ENT_QUOTES).'"'.$nonceAttribute.'></script>';
        }

        $tags .= '<script type="module" src="'.$url('frame.js').'"'.$nonceAttribute.$attributes.'></script>';

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
