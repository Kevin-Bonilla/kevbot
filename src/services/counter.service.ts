import fs from 'fs';
import path from 'path';

const counterPath = path.resolve(__dirname, '../../data/counter.json');

export class CounterService {
  private static counterData = JSON.parse(fs.readFileSync(counterPath, 'utf8'));

  static getCount() {
    return this.counterData.count;
  }

  static increment() {
    this.counterData.count++;
    fs.writeFileSync(counterPath, JSON.stringify(this.counterData, null, 2));
    return this.counterData.count;
  }
}
