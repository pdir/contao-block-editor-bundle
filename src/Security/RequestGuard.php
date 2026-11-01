<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Security;

use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Security\Csrf\CsrfToken;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;

/**
 * Gatekeeper for every API request.
 *
 * Contao's RequestTokenListener only covers POST requests, so PATCH needs its own
 * CSRF protection. All checks fail closed.
 */
final class RequestGuard
{
    public const TOKEN_HEADER = 'X-Block-Editor-Token';
    public const MAX_BODY_BYTES = 2_097_152;

    public function __construct(
        private readonly Security $security,
        private readonly CsrfTokenManagerInterface $csrfTokenManager,
        private readonly string $csrfTokenName,
    ) {
    }

    public function assertCanRead(Request $request): void
    {
        $this->assertBackendUser();
        $this->assertSameOrigin($request, false);
    }

    public function assertCanWrite(Request $request): void
    {
        $this->assertBackendUser();
        $this->assertSameOrigin($request, true);

        $contentType = strtolower(trim(explode(';', (string) $request->headers->get('Content-Type'))[0]));

        if ('application/json' !== $contentType) {
            throw new ApiException(415, 'Es wird application/json erwartet.');
        }

        $token = $request->headers->get(self::TOKEN_HEADER);

        if (!\is_string($token) || '' === $token || !$this->csrfTokenManager->isTokenValid(new CsrfToken($this->csrfTokenName, $token))) {
            throw new ApiException(403, 'Ungültiges Sicherheits-Token. Bitte die Seite neu laden.');
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function decodeJsonBody(Request $request): array
    {
        $body = $request->getContent();

        if (\strlen($body) > self::MAX_BODY_BYTES) {
            throw new ApiException(413, 'Die Anfrage ist zu groß.');
        }

        try {
            $data = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiException(400, 'Ungültiges JSON.');
        }

        if (!\is_array($data)) {
            throw new ApiException(400, 'Ungültiges JSON.');
        }

        return $data;
    }

    private function assertBackendUser(): void
    {
        if (!$this->security->isGranted('ROLE_USER')) {
            throw new ApiException(401, 'Bitte im Backend anmelden.');
        }
    }

    private function assertSameOrigin(Request $request, bool $requireOrigin): void
    {
        $fetchSite = $request->headers->get('Sec-Fetch-Site');

        if (null !== $fetchSite && 'same-origin' !== $fetchSite) {
            throw new ApiException(403, 'Anfragen von fremden Seiten sind nicht erlaubt.');
        }

        $origin = $request->headers->get('Origin');

        if (null === $origin) {
            if ($requireOrigin) {
                throw new ApiException(403, 'Anfragen von fremden Seiten sind nicht erlaubt.');
            }

            return;
        }

        if ($origin !== $request->getSchemeAndHttpHost()) {
            throw new ApiException(403, 'Anfragen von fremden Seiten sind nicht erlaubt.');
        }
    }
}
