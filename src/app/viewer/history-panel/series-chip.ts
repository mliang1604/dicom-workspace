import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  viewChild,
} from '@angular/core';
import type { Series } from '../../../dicom/series';
import { toImageData, type SeriesThumbnail } from '../series-thumbnail';

/**
 * One series row/chip: a small preview (the CPU thumbnail, or a modality icon),
 * the series description, its image count and modality.
 *
 * Deliberately presentational and stateless — it takes the series, its already
 * computed {@link SeriesThumbnail} and a `loaded` flag as inputs and renders
 * them. Factored out of the {@link import('./history-panel').HistoryPanel} so the
 * tree toggle (#172) and the alternate B/C timeline layouts can reuse the exact
 * same chip without duplicating its markup or drawing logic. Read-only here;
 * loading and drag-to-load is #173.
 */
@Component({
  selector: 'app-series-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './series-chip.html',
  styleUrl: './series-chip.css',
  host: {
    class: 'series-chip',
    '[class.loaded]': 'loaded()',
    // Marks the chip of the series currently displayed in the viewer.
    '[attr.aria-current]': "loaded() ? 'true' : null",
  },
})
export class SeriesChip {
  /** The series this chip describes. */
  readonly series = input.required<Series>();
  /** Its precomputed preview (image or icon), supplied by the parent's cache. */
  readonly thumbnail = input.required<SeriesThumbnail>();
  /** Whether this series is the one currently loaded in the viewport (highlight). */
  readonly loaded = input(false);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('thumb');

  /** Whether the preview is a rendered image (vs an icon fallback). */
  protected readonly isImage = computed(() => this.thumbnail().kind === 'image');
  /** Human label for the series (description, else its number). */
  protected readonly label = computed(() => seriesChipLabel(this.series()));
  /** `N img` / `1 img` summary of the series' image count. */
  protected readonly imageCount = computed(() => imageCountLabel(this.series().imageCount));
  /** The series' modality, upper-cased, or null. */
  protected readonly modality = computed(() => this.series().modality);
  /** Glyph shown when there's no grayscale preview (RT objects, no pixels). */
  protected readonly icon = computed(() => modalityGlyph(this.series().modality));

  constructor() {
    // Paint the preview onto the chip's canvas whenever the thumbnail (or the
    // canvas, once @if reveals it) changes. Guarded for environments without a
    // 2D context (jsdom in unit tests), where the chip degrades to no image.
    effect(() => {
      const thumbnail = this.thumbnail();
      const canvas = this.canvasRef()?.nativeElement;
      if (!canvas || thumbnail.kind !== 'image') return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { pixels } = thumbnail;
      canvas.width = pixels.width;
      canvas.height = pixels.height;
      ctx.putImageData(toImageData(pixels), 0, 0);
    });
  }
}

/** A series' chip label: its description, falling back to `Series <number>`. */
export function seriesChipLabel(series: Series): string {
  const description = series.description?.trim();
  if (description) return description;
  return series.seriesNumber !== null ? `Series ${series.seriesNumber}` : 'Series';
}

/** Pluralised image-count summary, e.g. `1 img` / `120 img`. */
export function imageCountLabel(count: number): string {
  return `${count} img`;
}

/**
 * A representative glyph for a modality's icon fallback (RT objects, registrations,
 * reports — anything without a grayscale preview). A generic disc otherwise.
 */
export function modalityGlyph(modality: string | null): string {
  switch (modality?.toUpperCase()) {
    case 'RTSTRUCT':
      return '◌';
    case 'RTDOSE':
      return '◉';
    case 'RTPLAN':
    case 'RTRECORD':
      return '⊞';
    case 'SEG':
      return '▦';
    case 'REG':
      return '⇄';
    case 'PR':
    case 'KO':
    case 'SR':
      return '▤';
    default:
      return '⬚';
  }
}
