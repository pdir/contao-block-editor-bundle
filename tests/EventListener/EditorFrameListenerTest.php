<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\EventListener;

use Contao\ContentModel;
use Contao\CoreBundle\Security\Authentication\Token\TokenChecker;
use Pdir\ContaoBlockEditorBundle\Element\EditorAssets;
use Pdir\ContaoBlockEditorBundle\EventListener\EditorFrameListener;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\HttpKernelInterface;

final class EditorFrameListenerTest extends TestCase
{
    #[DataProvider('redirects')]
    public function testKeepsEditorInRedirect(string $location, string $expected): void
    {
        $request = Request::create('https://example.com/preview.php/start.html', server: ['SCRIPT_NAME' => '/preview.php', 'SCRIPT_FILENAME' => '/preview.php']);

        $this->assertSame($expected, EditorFrameListener::keepEditorInRedirect($location, $request));
    }

    public static function redirects(): iterable
    {
        yield 'absolute' => ['https://example.com/a.html', 'https://example.com/preview.php/a.html?_block_editor=1'];
        yield 'path' => ['/a.html?x=1#y', '/preview.php/a.html?x=1&_block_editor=1#y'];
        yield 'preview already' => ['/preview.php/a.html', '/preview.php/a.html?_block_editor=1'];
        yield 'marker already' => ['/preview.php/a.html?_block_editor=1', '/preview.php/a.html?_block_editor=1'];
        yield 'similar path' => ['/preview.phpx', '/preview.php/preview.phpx?_block_editor=1'];
        yield 'other host' => ['https://other.example/a.html', 'https://other.example/a.html'];
        yield 'relative' => ['a.html', 'a.html'];
    }

    #[DataProvider('markup')]
    public function testAddsMarkerToRootTag(string $buffer, string $expected): void
    {
        $this->assertSame($expected, EditorFrameListener::addMarker($buffer, 7));
    }

    public static function markup(): iterable
    {
        yield 'simple' => ['<div class="a">x</div>', '<div data-be-id="7" class="a">x</div>'];
        yield 'headline' => ['<h2>x</h2>', '<h2 data-be-id="7">x</h2>'];
        yield 'leading comment and whitespace' => ["\n<!-- indexer::stop -->\n<div>x</div>", "\n<!-- indexer::stop -->\n<div data-be-id=\"7\">x</div>"];
        yield 'plain text stays untouched' => ['nur Text', 'nur Text'];
        yield 'empty stays untouched' => ['', ''];
        yield 'marked alias target keeps its id' => ['<div data-be-id="3">x</div>', '<div data-be-id="3">x</div>'];
        yield 'nested marked child does not count' => ['<div><p data-be-id="3">x</p></div>', '<div data-be-id="7"><p data-be-id="3">x</p></div>'];
    }

    /**
     * Regular visitors must never receive editor markup or assets.
     */
    #[DataProvider('nonEditorRequests')]
    public function testDoesNothingOutsideOfTheEditor(bool $preview, bool $parameter, bool $backendUser): void
    {
        $request = $this->request($preview, $parameter);
        $listener = $this->listener($request, $backendUser);

        $model = $this->createStub(ContentModel::class);
        $model->method('__get')->willReturn(5);

        $this->assertSame('<div>x</div>', $listener->markElement($model, '<div>x</div>'));

        $response = new Response('<body></body>');
        $response->headers->set('Cache-Control', 'public, s-maxage=100');
        $listener->onResponse($this->event($request, $response));

        $this->assertSame('<body></body>', $response->getContent());
        $this->assertStringContainsString('public', (string) $response->headers->get('Cache-Control'));
    }

    public static function nonEditorRequests(): iterable
    {
        yield 'regular visitor' => [false, false, false];
        yield 'visitor adding the parameter' => [false, true, false];
        yield 'parameter on preview without login' => [true, true, false];
        yield 'logged-in user on the live site' => [false, true, true];
        yield 'normal preview' => [true, false, true];
    }

    public function testPreparesTheEditorPage(): void
    {
        $request = $this->request(true, true);
        $listener = $this->listener($request, true);

        $response = new Response('<body><p>x</p></body>');
        $response->headers->set('Cache-Control', 'public, s-maxage=100');
        $listener->onResponse($this->event($request, $response));

        $this->assertStringContainsString('frame.js', (string) $response->getContent());
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->assertStringNotContainsString('public', (string) $response->headers->get('Cache-Control'));
    }

    public function testReusesTheNonceOfThePageCsp(): void
    {
        $request = $this->request(true, true);
        $response = new Response('<body></body>');
        $response->headers->set('Content-Security-Policy', "script-src 'nonce-abc123'");

        $this->listener($request, true)->onResponse($this->event($request, $response));

        $this->assertMatchesRegularExpression('/frame\.js\?v=[0-9a-f]{32}" nonce="abc123"/', (string) $response->getContent());
        $this->assertSame("script-src 'nonce-abc123'", $response->headers->get('Content-Security-Policy'));
    }

    public function testExtendsAPageCspWithoutNonce(): void
    {
        $request = $this->request(true, true);
        $response = new Response('<body></body>');
        $response->headers->set('Content-Security-Policy', "default-src 'none'; script-src https://cdn.example; style-src 'self'");

        $this->listener($request, true)->onResponse($this->event($request, $response));

        $this->assertSame("default-src 'none'; script-src 'self' https://cdn.example; style-src 'self'", $response->headers->get('Content-Security-Policy'));
    }

    private function request(bool $preview, bool $parameter): Request
    {
        $request = Request::create('/seite.html'.($parameter ? '?'.EditorFrameListener::QUERY_PARAMETER.'=1' : ''));
        $request->attributes->set('_preview', $preview);

        return $request;
    }

    private function listener(Request $request, bool $backendUser): EditorFrameListener
    {
        $stack = new RequestStack();
        $stack->push($request);

        $tokenChecker = $this->createStub(TokenChecker::class);
        $tokenChecker->method('hasBackendUser')->willReturn($backendUser);

        return new EditorFrameListener($stack, $tokenChecker, new EditorAssets('/tmp'));
    }

    private function event(Request $request, Response $response): ResponseEvent
    {
        return new ResponseEvent($this->createStub(HttpKernelInterface::class), $request, HttpKernelInterface::MAIN_REQUEST, $response);
    }
}
