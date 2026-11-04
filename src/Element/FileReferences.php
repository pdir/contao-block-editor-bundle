<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Image\ImageFactoryInterface;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\FilesModel;
use Contao\StringUtil;
use Contao\Validator;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * The files of a file tree field (an image, the images of a gallery, a download), as the editor
 * shows them: in the stored order, with a small preview for images.
 */
final class FileReferences
{
    public const MAX_FILES = 500;

    private const PREVIEW_SIZE = [160, 120, 'box'];

    private const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'gif', 'png', 'webp', 'avif', 'svg', 'svgz', 'heic', 'jxl'];

    public function __construct(
        private readonly ContaoFramework $framework,
        private readonly ImageFactoryInterface $imageFactory,
        private readonly Security $security,
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
    ) {
    }

    /**
     * @return list<array{uuid: string, path: string, name: string, image: bool, preview: string|null}>
     */
    public function describe(mixed $value): array
    {
        $uuids = array_values(array_filter(
            \is_array($value) ? $value : [$value],
            static fn (mixed $uuid): bool => \is_string($uuid) && 16 === \strlen($uuid),
        ));

        if (!$uuids) {
            return [];
        }

        $this->framework->initialize();
        $models = $this->framework->getAdapter(FilesModel::class)->findMultipleByUuids($uuids);
        $byUuid = [];

        foreach ($models ?? [] as $model) {
            $byUuid[$model->uuid] = $model;
        }

        $files = [];

        foreach ($uuids as $uuid) {
            if (!$model = $byUuid[$uuid] ?? null) {
                continue;
            }

            $path = (string) $model->path;
            $image = 'file' === $model->type && \in_array(strtolower((string) $model->extension), self::IMAGE_EXTENSIONS, true);

            $files[] = [
                'uuid' => StringUtil::binToUuid($uuid),
                'path' => $path,
                'name' => basename($path),
                'image' => $image,
                'preview' => $image ? $this->preview($path) : null,
            ];
        }

        return $files;
    }

    /**
     * The chosen files as UUIDs, in the order given. The picker sends paths, the inspector UUIDs.
     * Files that are not referenced yet must be in the user's file mounts.
     *
     * @param list<string> $current the UUIDs (binary) the field holds now
     *
     * @return list<string> UUIDs as strings
     */
    public function resolve(mixed $value, array $current): array
    {
        $entries = \is_string($value) ? array_filter(explode(',', $value)) : $value;

        if (!\is_array($entries) || !array_is_list($entries) || \count($entries) > self::MAX_FILES) {
            throw new ApiException(400, 'Ungültige Dateiauswahl.');
        }

        $this->framework->initialize();
        $files = $this->framework->getAdapter(FilesModel::class);
        $uuids = [];

        foreach ($entries as $entry) {
            if (!\is_string($entry) || '' === $entry || \strlen($entry) > 4096) {
                throw new ApiException(400, 'Ungültige Dateiauswahl.');
            }

            $model = Validator::isUuid($entry) ? $files->findByUuid($entry) : ($files->findByPath($entry) ?? $files->findByPath(rawurldecode($entry)));

            if (!$model instanceof FilesModel) {
                throw new ApiException(422, 'Die gewählte Datei gibt es nicht mehr.');
            }

            if (!\in_array($model->uuid, $current, true) && !$this->security->isGranted(ContaoCorePermissions::USER_CAN_ACCESS_PATH, $model->path)) {
                throw new ApiException(403, 'Kein Zugriff auf diese Datei.');
            }

            $uuids[] = StringUtil::binToUuid($model->uuid);
        }

        return array_values(array_unique($uuids));
    }

    private function preview(string $path): string|null
    {
        try {
            return $this->imageFactory->create($this->projectDir.'/'.$path, self::PREVIEW_SIZE)->getUrl($this->projectDir);
        } catch (\Throwable) {
            return null;
        }
    }
}
