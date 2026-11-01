<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Security;

use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Pdir\ContaoBlockEditorBundle\Security\RequestGuard;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;

final class RequestGuardTest extends TestCase
{
    public function testAcceptsAValidWrite(): void
    {
        $this->expectNotToPerformAssertions();

        $this->guard()->assertCanWrite($this->request());
    }

    /**
     * @param array<string, string|null> $headers
     */
    #[DataProvider('rejectedWrites')]
    public function testRejectsWrite(array $headers, int $status, bool $loggedIn = true, bool $tokenValid = true): void
    {
        try {
            $this->guard($loggedIn, $tokenValid)->assertCanWrite($this->request($headers));
            $this->fail('The request was not rejected.');
        } catch (ApiException $exception) {
            $this->assertSame($status, $exception->status);
        }
    }

    public static function rejectedWrites(): iterable
    {
        yield 'not logged in' => [[], 401, false];
        yield 'foreign origin' => [['Origin' => 'https://evil.example'], 403];
        yield 'origin with other scheme' => [['Origin' => 'http://example.com'], 403];
        yield 'missing origin' => [['Origin' => null], 403];
        yield 'cross-site fetch' => [['Sec-Fetch-Site' => 'cross-site'], 403];
        yield 'same-site fetch (sibling subdomain)' => [['Sec-Fetch-Site' => 'same-site'], 403];
        yield 'form content type' => [['Content-Type' => 'application/x-www-form-urlencoded'], 415];
        yield 'text content type' => [['Content-Type' => 'text/plain'], 415];
        yield 'missing token' => [['X-Block-Editor-Token' => null], 403];
        yield 'invalid token' => [[], 403, true, false];
    }

    public function testRejectsForeignReads(): void
    {
        $this->expectException(ApiException::class);

        $this->guard()->assertCanRead($this->request(['Sec-Fetch-Site' => 'cross-site']));
    }

    public function testRejectsOversizedAndMalformedBodies(): void
    {
        foreach ([str_repeat('a', RequestGuard::MAX_BODY_BYTES + 1) => 413, '{broken' => 400, '"text"' => 400] as $body => $status) {
            try {
                $this->guard()->decodeJsonBody(Request::create('/', 'PATCH', content: (string) $body));
                $this->fail('The body was not rejected.');
            } catch (ApiException $exception) {
                $this->assertSame($status, $exception->status);
            }
        }
    }

    private function guard(bool $loggedIn = true, bool $tokenValid = true): RequestGuard
    {
        $security = $this->createStub(Security::class);
        $security->method('isGranted')->willReturn($loggedIn);

        $tokens = $this->createStub(CsrfTokenManagerInterface::class);
        $tokens->method('isTokenValid')->willReturn($tokenValid);

        return new RequestGuard($security, $tokens, 'contao_csrf_token');
    }

    /**
     * @param array<string, string|null> $overrides
     */
    private function request(array $overrides = []): Request
    {
        $request = Request::create('https://example.com/contao/block-editor/api/elements/1', 'PATCH');

        $headers = [
            'Origin' => 'https://example.com',
            'Sec-Fetch-Site' => 'same-origin',
            'Content-Type' => 'application/json; charset=utf-8',
            'X-Block-Editor-Token' => 'token',
            ...$overrides,
        ];

        foreach ($headers as $name => $value) {
            null === $value ? $request->headers->remove($name) : $request->headers->set($name, $value);
        }

        return $request;
    }
}
