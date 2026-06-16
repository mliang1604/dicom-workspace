import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Viewer } from './viewer/viewer';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Viewer],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
