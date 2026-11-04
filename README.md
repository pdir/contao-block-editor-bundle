# Contao Block Editor

**Contao Block Editor** ist ein moderner, performanter Editor für Contao, inspiriert von blockbasierten Editoren wie Gutenberg,
aber gebaut für die Contao-Architektur.
Redakteure klicken ein Element in der Live-Vorschau an und bearbeiten es sofort, ohne Ladezeiten, Seitenwechsel oder Umweg
über das Backend-Formular. Alle Inhalte bleiben ganz normale Contao-Inhaltselemente: Templates, Insert-Tags, Versionierung,
Benutzerrechte und Elemente anderer Erweiterungen funktionieren wie gewohnt.

[![Der Contao Block Editor im Einsatz: Text direkt auf der Seite bearbeiten](https://github.com/user-attachments/assets/7fe6098f-8a5a-4ffe-93db-ccc7df2205fb)](https://github.com/user-attachments/assets/01e456d4-e2e5-4be5-8863-aef37f932322)

*Klick auf das Bild öffnet das Video (1 Minute).*

**Highlights**
- Inline-Bearbeitung direkt im Frontend-Rendering
- Sofortiger Wechsel vom Klick zum Editieren, ohne Server-Roundtrip
- Drag & Drop, Undo/Redo und Autosave
- Inspector automatisch aus dem DCA generiert, auch für Drittanbieter-Elemente
- Respektiert Contao-Benutzerrechte und Versionierung
- Jederzeit Rückfall auf das klassische Backend

## Stand

Umgesetzt sind Inline-Text (Elemente `text` und `headline`), Inspector aus dem DCA, Autosave mit Versionierung und das
Verschieben von Elementen, auch zwischen Artikeln und Spalten: per Griff links neben dem Element oder mit Alt + Pfeil
hoch/runter, wenn das Element den Fokus hat. Ziel ist immer ein bearbeitbares Element, leere Artikel sind noch kein
Ablageziel. Links außerhalb der bearbeitbaren Elemente führen im Editor zur nächsten Seite, vorher wird alles gespeichert;
externe Links und Dateien öffnen einen neuen Tab. Links im Inhalt zeigen beim Klick eine Leiste mit Öffnen und Bearbeiten;
im Text lassen sie sich dort ändern oder entfernen und mit Strg/Cmd + K neu anlegen. Liegt ein Element in einem
anderen, etwa in einer Gruppe oder einem Modul, wählt der erste Button der Leiste über dem Text das übergeordnete Element aus. Der Editor öffnet sich im Backend über die Operation „Im Block-Editor öffnen“ im Seitenbaum.
Unter „Mehr erfahren“ im Inspector lässt sich „Navigationslinks bearbeiten“ einschalten: Ein Klick auf einen Menüpunkt
ändert dann den Seitennamen direkt im Menü, und der Inspector zeigt die weiteren Angaben der Seite. Es gelten die Rechte
für Seiten aus dem Backend, gespeichert wird mit Versionierung wie bei den Elementen.
Auf der Detailseite einer Nachricht oder eines Events lassen sich der Titel (bei Nachrichten auch die Unterüberschrift)
direkt in der Seite und im Inspector ändern, mit den Rechten und der Versionierung des Backends. Ist kein Element
ausgewählt, zeigt der Inspector Seitentitel und Beschreibung der aktuellen Seite für Suchmaschinen; sie werden ebenso
gespeichert.
Neue Elemente kommen über das Plus unter dem Griff oder den Button „Element darunter einfügen“ im Inspector unter das
gewählte Element. Zur Wahl stehen die Elementtypen, die der Benutzer an dieser Stelle anlegen darf, auch in verschachtelten
Elementen; das neue Element erhält die Standardwerte aus dem DCA und öffnet sich gleich zum Schreiben.
Tabellen werden Zelle für Zelle in der Seite bearbeitet: Tab springt zur nächsten Zelle, die Leiste über der Tabelle
fügt Zeilen und Spalten ein oder löscht sie. Zellen mit HTML und alle Zellen per Tastatur bearbeitet der Inspector.
Aufzählungen ebenso Eintrag für Eintrag: Enter legt darunter einen neuen Eintrag an, Rücktaste in einem leeren Eintrag
entfernt ihn. Einträge mit HTML bearbeitet der Inspector.
„Löschen“ im Inspector entfernt das gewählte Element samt verschachtelter Elemente, wenn der Benutzer es löschen darf.
Wie im Backend landet es in „Wiederherstellen“; direkt danach holt „Rückgängig“ in der Kopfzeile es zurück.
Mit dem Stift in der Kopfzeile oder der Taste `E` lässt sich das Bearbeiten ausschalten, um sich nur auf der Seite zu
bewegen: Dann führt jeder Link zu seiner Seite. Jeder neue Editor startet mit eingeschaltetem Bearbeiten.
Die Tastaturbefehle erklärt der Inspector unter „Globale Tastaturbefehle“ (Taste `?`). Einzelne Tasten wirken nur,
wenn gerade kein Text bearbeitet wird, und lassen sich für Screenreader abschalten. Beim Schreiben gilt nur
Strg/⌘ + Umschalt + Komma für den Inspector. Kombinationen der Browser und Tasten, die Zeichen erzeugen (⌥ auf dem Mac,
AltGr unter Windows), bleiben unberührt.

Noch offen: Kopieren, globales Undo/Redo, Datei- und Linkpicker, Patterns, Sprachwechsel,
Responsive-Vorschau und die Erweiterungs-API. Felder, die der Editor noch nicht unterstützt, bleiben über den Link
„Im klassischen Backend bearbeiten“ erreichbar.

## Installation

Voraussetzung ist Contao 5.7 oder 6.0 mit PHP 8.3 oder neuer (Contao 6 verlangt PHP 8.4).

### Contao Managed Edition

Es sind keine manuellen Schritte nötig. Das Bundle und seine Routen werden über das Manager-Plugin registriert:

```bash
composer require pdir/contao-block-editor-bundle
```

### Contao als Teil einer eigenen Symfony-Anwendung

Ohne Managed Edition wird das Manager-Plugin nicht ausgeführt. Voraussetzung ist eine bereits lauffähige
Contao-Installation; danach sind diese Schritte manuell nötig:

**1. Paket installieren**

```bash
composer require pdir/contao-block-editor-bundle
```

**2. Bundle registrieren** in `config/bundles.php`, nach dem `ContaoCoreBundle`:

```php
return [
    // ...
    Contao\CoreBundle\ContaoCoreBundle::class => ['all' => true],
    Pdir\ContaoBlockEditorBundle\ContaoBlockEditorBundle::class => ['all' => true],
];
```

**3. Routen einbinden** in `config/routes.yaml`, vor den Contao-Routen:

```yaml
pdir_block_editor:
    resource: '@ContaoBlockEditorBundle/config/routes.yaml'

contao:
    resource: '@ContaoCoreBundle/config/routes.yaml'
```

**4. Vorschau-Einstieg einrichten.** Der Editor zeigt die Seite über das Vorschau-Skript von Contao an. Die Managed Edition
bringt es mit, sonst ist `contao.preview_script` leer und der Editor meldet, dass das Skript fehlt.

In `config/packages/contao.yaml`:

```yaml
contao:
    preview_script: /preview.php
```

Dazu die Datei `public/preview.php` anlegen und bei Bedarf an den eigenen Front-Controller anpassen:

```php
<?php

declare(strict_types=1);

use App\Kernel;
use Symfony\Component\HttpFoundation\Request;

require dirname(__DIR__).'/vendor/autoload.php';

$request = Request::createFromGlobals();
$request->attributes->set('_preview', true);

$kernel = new Kernel('prod', false);
$response = $kernel->handle($request);

$response->headers->set('X-Robots-Tag', 'noindex');
$response->headers->set('Cache-Control', 'no-store');
$response->send();

$kernel->terminate($request, $response);
```

Diese Datei darf nicht über einen HTTP-Cache wie `HttpCache` laufen, sonst könnten Vorschauseiten mit Editor-Markup
im Cache landen. Der Webserver muss sie außerdem als PHP-Skript ausführen, auch mit Pfadanteil (`/preview.php/seite.html`).

**5. Assets veröffentlichen und Cache leeren**

```bash
bin/console assets:install public
bin/console cache:clear
```

Eine Datenbank-Migration ist nicht nötig, weil das Bundle keine eigenen Tabellen oder Spalten anlegt.

## Update

Nach jedem Update müssen die Dateien unter `public/bundles/contaoblockeditor` zur Bundle-Version passen. In der Managed
Edition erledigt das `contao-setup` bei `composer install` und `composer update`. Sonst und bei Entwicklung per
Path-Repository:

```bash
bin/console assets:install public --symlink
```

Mit `--symlink` bleiben die Dateien automatisch aktuell. Passen sie nicht zusammen, öffnet sich der Editor nicht und
zeigt diesen Hinweis, denn alte Skripte verstehen die aktuelle API nicht und könnten Inhalte beschädigen.

## Den Editor für formatierten Text erweitern

Felder mit WYSIWYG-Editor im Backend (`eval.rte`) bearbeitet der Block-Editor in der Seite und im Inspector mit einem
schlanken Editor ([Tiptap](https://tiptap.dev)): Fett, Kursiv, Link sowie Aufzählungen. Andere Bundles können weitere
Formate und Buttons ergänzen. Dazu tragen sie ein Skript ein, das im Block-Editor und in der Seitenvorschau geladen wird:

```yaml
# config/config.yaml
contao_block_editor:
    editor_scripts:
        - bundles/acmeeditor/block-editor.js
```

Das Skript legt seine Erweiterung in `window.contaoBlockEditorExtensions` ab. Die Reihenfolge der Skripte spielt keine
Rolle, weil der Editor die Liste erst beim Start liest:

```js
(window.contaoBlockEditorExtensions ??= []).push({
    // Tiptap-Erweiterungen, gebaut mit den Klassen des Editors (Extension, Mark, Node, mergeAttributes)
    extensions: ({ Mark }) => [
        Mark.create({
            name: 'superscript',
            parseHTML: () => [{ tag: 'sup' }],
            renderHTML: () => ['sup', 0],
        }),
    ],
    // Buttons in der Formatleiste
    buttons: [{
        label: 'x²',
        title: 'Hochgestellt',
        // Optional: Pfad eines 24 × 24 großen Icons wie die von Contao, sonst steht das Label auf dem Button
        icon: { d: 'M4 18 9 6h2l5 12h-2l-1.3-3.3H7.3L6 18Zm4-5h4L10 8Z', rule: 'nonzero' },
        run: (editor) => editor.chain().focus().toggleMark('superscript').run(),
        active: (editor) => editor.isActive('superscript'),
    }],
    // Markup, das die Erweiterung schreibt: Texte damit bleiben im Editor bearbeitbar
    allow: { SUP: [] },
});
```

Texte mit Markup, das weder der Editor noch eine Erweiterung kennt, öffnet der Block-Editor nur als HTML, damit nichts
verloren geht. Was gespeichert wird, filtert Contao weiterhin nach den erlaubten Tags aus den Einstellungen.

## Lizenz

Der Block-Editor steht unter der GNU Lesser General Public License, Version 3 oder (nach Wahl) jeder späteren
Version (LGPL-3.0-or-later). Den Lizenztext enthält [`LICENSE`](LICENSE).

Die Icons der Formatleiste stammen aus dem Standard-Iconset von [HugeRTE](https://github.com/hugerte/hugerte), dem
Editor für formatierten Text im Contao-Backend. Sie stehen unter der MIT-Lizenz, © 2022 Ephox Corporation DBA Tiny
Technologies, Inc. und © 2025 HugeRTE contributors. Den Lizenztext enthält
[`licenses/HugeRTE.txt`](licenses/HugeRTE.txt).

## Entwicklung

```bash
composer install
npm ci --ignore-scripts && npm rebuild esbuild
npm run build        # erzeugt public/ und prüft das Größenbudget
npm run typecheck
npm test
vendor/bin/phpunit
```

Die Browser-Tests in `tests/e2e/` laufen gegen eine echte Contao-Instanz mit den Daten aus `tests/e2e/seed.sql`
(Test-Zugänge, nur lokal verwenden). Das Skript erwartet die Instanz unter `http://127.0.0.1:8765` und `playwright`
als Abhängigkeit. Der Lauf ändert die Testdaten, daher vor jedem Lauf die Elemente 10 und 11 zurücksetzen.
