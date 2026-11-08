<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\EventListener;

use Contao\CoreBundle\DependencyInjection\Attribute\AsHook;
use Contao\Template;
use Pdir\ContaoBlockEditorBundle\Record\ShownTexts;

/**
 * Marks each event of a list in the editor frame, like NewsListListener does for news, and
 * remembers how the templates show its date and time. Those are formatted for the page, so
 * the page can only find them by these texts. The event of a reader page is found by its
 * address and only needs the texts.
 */
final class EventListListener
{
    public const CLASS_PREFIX = 'cbe-event-';

    public function __construct(
        private readonly EditorFrameListener $frame,
        private readonly ShownTexts $shown,
    ) {
    }

    #[AsHook('parseTemplate')]
    public function markEvent(Template $template): void
    {
        $name = $template->getName();
        $id = (int) $template->id;

        if ($id < 1 || !str_starts_with($name, 'event_') || !$this->frame->isEditorRequest()) {
            return;
        }

        $this->shown->set('tl_calendar_events', $id, [
            'startDate' => ShownTexts::plain($template->date),
            'startTime' => ShownTexts::plain($template->time),
        ]);

        if (str_starts_with($name, 'event_full')) {
            return;
        }

        // The list templates take the classes of the event from one of these
        $template->classList = (string) $template->classList.' '.self::CLASS_PREFIX.$id;
        $template->classUpcoming = (string) $template->classUpcoming.' '.self::CLASS_PREFIX.$id;
    }
}
