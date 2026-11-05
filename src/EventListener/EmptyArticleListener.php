<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\EventListener;

use Contao\CoreBundle\DependencyInjection\Attribute\AsHook;
use Contao\FrontendTemplate;
use Contao\Module;
use Pdir\ContaoBlockEditorBundle\Element\ElementCreator;

/**
 * An article without elements offers to add the first one. Every other element is added next
 * to an existing one, which an empty article doesn't have. Only in the editor frame, and only
 * for users who may add something there.
 */
final class EmptyArticleListener
{
    public function __construct(
        private readonly EditorFrameListener $frame,
        private readonly ElementCreator $creator,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    #[AsHook('compileArticle')]
    public function addPlaceholder(FrontendTemplate $template, array $data, Module $module): void
    {
        $id = (int) ($data['id'] ?? 0);

        if ($id < 1 || $template->noMarkup || $template->teaserOnly || !empty($template->elements) || !$this->frame->isEditorRequest() || !$this->creator->canAddToArticle($id)) {
            return;
        }

        $template->elements = [self::placeholder($id)];
    }

    /**
     * The frame turns it into a button. The ID is an integer, so no escaping is required.
     */
    public static function placeholder(int $id): string
    {
        return '<div class="cbe-empty-article" data-cbe-article="'.$id.'"></div>';
    }
}
