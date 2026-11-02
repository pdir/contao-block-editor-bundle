# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Redakteure ohne technischen Hintergrund. Sie pflegen die Inhalte einer Contao-Website, kennen das Backend wenig oder empfinden es als umständlich und sollen den Editor ohne Schulung bedienen können. Ihre Aufgabe: einen Text oder ein Element auf der Website finden, ändern und sicher sein, dass die Änderung gespeichert ist.

## Product Purpose

Der Contao Block Editor (`pdir/contao-block-editor-bundle`) ist ein blockbasierter Editor für Contao. Redakteure klicken ein Element in der Vorschau an und bearbeiten es sofort, ohne Seitenwechsel und ohne Umweg über das Backend-Formular.

Erfolg bedeutet: Redakteure erledigen Inhaltsänderungen selbstständig auf der Seite, auf der sie sie sehen, und müssen dafür nicht ins klassische Backend wechseln.

## Positioning

„Contao-Inhalte bearbeiten, wo sie entstehen: direkt auf der Seite.“

Das Bearbeiten direkt auf der echten Seite ist das Kernversprechen. Es wird durch zwei Eigenschaften gestützt: Der Klick führt ohne Server-Roundtrip zum Bearbeiten, und alle Inhalte bleiben normale Contao-Inhaltselemente in `tl_content`. Die Bedienung orientiert sich an Block-Editoren wie Gutenberg, das ist aber Inspiration und nicht die Positionierung.

## Operating Context

- Der Editor wird im Contao-Backend über die Operation „Im Block-Editor öffnen“ im Seitenbaum gestartet.
- Er ist eine eigene Oberfläche neben dem Backend und muss nicht wie das Backend aussehen. Der Weg zurück („Zum Backend“) bleibt immer erreichbar.
- Die Seite läuft mit dem Theme der jeweiligen Website in einem Same-Origin-Iframe über den Preview-Einstiegspunkt. Das Aussehen der bearbeiteten Seite ist also je Installation anders und gehört der Website, nicht dem Editor.
- Nutzung am Desktop-Rechner im Arbeitsalltag der Redaktion. Die Viewport-Umschaltung zeigt die Seite in Tablet- und Mobilbreite, der Editor selbst ist kein Mobilwerkzeug. *(Als Annahme aus dem Code abgeleitet, nicht ausdrücklich bestätigt.)*

## Capabilities and Constraints

**Umgesetzt:** Inline-Text (`text`, `headline`), aus dem DCA generierter Inspector, Autosave mit Versionierung, Verschieben per Griff und Tastatur auch zwischen Artikeln und Spalten, Navigation über die Website im Editor, Link-Leiste zum Öffnen und Bearbeiten von Links, Viewport-Umschalter, Inspector ein- und ausblenden, Rückfall auf das klassische Backend.

**Geplant, noch nicht vorhanden (nicht als fertig darstellen):** Inserter, Kopieren und Löschen, globales Undo/Redo, Datei- und Linkpicker, Patterns, Sprachwechsel, Erweiterungs-API.

**Technische Grenzen:**
- Contao 5.7 oder 6.0 mit PHP 8.3 oder neuer.
- Die Editor-Oberfläche hat eine strikte Content Security Policy: keine Inline-Styles oder -Skripte im Markup und keine externen Quellen für Schriften, Bilder oder Skripte.
- Größenbudgets des Builds (gzip): `shell.js` 8 KiB, `frame.js` 130 KiB, `shell.css` 3 KiB, `frame.css` 1 KiB.
- Klick zum Bearbeiten: Ziel unter 16 ms, spätestens unter 50 ms.
- Editor-Stile dürfen das Theme der Seite nicht beeinflussen und umgekehrt.

**Begriffe:** Inspector (Seitenleiste für Felder), Element (Contao-Inhaltselement), Griff (Verschieben), Link-Leiste, Klassisches Backend.

## Brand Commitments

- Name: Contao Block Editor; Herausgeber laut Paketname: pdir.
- Die Oberflächensprache ist derzeit Deutsch.
- Der Editor ist eigenständig gestaltet und nicht an das Erscheinungsbild des Contao-Backends gebunden.

## Evidence on Hand

- Technische Nachweise im Repository: PHPUnit, Vitest und Playwright-E2E (`tests/`).
- Keine Referenzen, Kundenstimmen, Nutzungszahlen oder Performance-Benchmarks für die öffentliche Darstellung vorhanden. Diese dürfen nicht erfunden werden.

## Product Principles

1. **Die Seite ist die Oberfläche.** Bearbeitet wird im echten Ergebnis; Formulare und Einstellungen sind die Ausnahme.
2. **Ohne Schulung verständlich.** Bedienelemente erklären sich selbst oder in einem kurzen Satz; Fachbegriffe aus Contao werden nicht vorausgesetzt.
3. **Nichts geht verloren.** Der Speicherzustand ist jederzeit erkennbar, Fehler werden klar gemeldet, und vor einem Seitenwechsel wird alles gespeichert.
4. **Tempo ist eine Funktion.** Keine Wartezeit zwischen Klick und Bearbeiten; neue Funktionen dürfen das nicht verschlechtern.
5. **Niemand wird eingesperrt.** Was der Editor nicht kann, bleibt über das klassische Backend erreichbar, und die Daten bleiben normales Contao.

## Accessibility & Inclusion

WCAG 2.2 AA als verbindliches Ziel für die Editor-Oberfläche: vollständige Tastaturbedienung, sichtbare Fokusführung und korrekte ARIA-Auszeichnung. Das Theme der bearbeiteten Seite liegt außerhalb dieses Anspruchs, die Bedienelemente des Editors in der Seite gehören dazu.
