<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Exception;

/**
 * An expected API failure. The message and details are shown to the editor, so
 * they must never contain internal information.
 */
final class ApiException extends \RuntimeException
{
    /**
     * @param array<string, mixed> $details
     */
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly array $details = [],
    ) {
        parent::__construct($message);
    }
}
