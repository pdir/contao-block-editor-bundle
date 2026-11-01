# Contao Block Editor

**Contao Block Editor** ist ein moderner, performanter Editor für Contao, inspiriert von blockbasierten Editoren wie Gutenberg,
aber gebaut für die Contao-Architektur.
Redakteure klicken ein Element in der Live-Vorschau an und bearbeiten es sofort, ohne Ladezeiten, Seitenwechsel oder Umweg
über das Backend-Formular. Alle Inhalte bleiben ganz normale Contao-Inhaltselemente: Templates, Insert-Tags, Versionierung,
Benutzerrechte und Elemente anderer Erweiterungen funktionieren wie gewohnt.

**Highlights**
- Inline-Bearbeitung direkt im Frontend-Rendering
- Sofortiger Wechsel vom Klick zum Editieren, ohne Server-Roundtrip
- Drag & Drop, Undo/Redo und Autosave
- Inspector automatisch aus dem DCA generiert, auch für Drittanbieter-Elemente
- Respektiert Contao-Benutzerrechte und Versionierung
- Jederzeit Rückfall auf das klassische Backend

## Stand

Umgesetzt ist der erste MVP-Schritt: Inline-Text (Elemente `text` und `headline`), Inspector aus dem DCA und
Autosave mit Versionierung. Der Editor öffnet sich im Backend über die Operation „Im Block-Editor öffnen“ im Seitenbaum.

Noch offen: Drag & Drop, Inserter, Kopieren/Löschen, globales Undo/Redo, Datei- und Linkpicker, Patterns, Sprachwechsel,
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

`framework.assets` muss aktiv sein, was mit installiertem `symfony/asset` standardmäßig gilt. Eine Datenbank-Migration ist
nicht nötig, weil das Bundle keine eigenen Tabellen oder Spalten anlegt.

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
