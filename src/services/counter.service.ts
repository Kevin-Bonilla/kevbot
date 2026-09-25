import fs from 'fs';
import path from 'path';

const counterPath = path.resolve(__dirname, '../../data/counter.json');

export class CounterService {
  private static counterData = JSON.parse(fs.readFileSync(counterPath, 'utf8'));

  /**
   * Retrieves the current value of the counter.
   * @returns {number} The current counter value.
   */
  static getCount() {
    return this.counterData.count;
  }

  /**
   * Increments the counter value and persists the change to the JSON file.
   * @returns {number} The newly incremented counter value.
   */
  static increment() {
    this.counterData.count++;
    fs.writeFileSync(counterPath, JSON.stringify(this.counterData, null, 2));
    return this.counterData.count;
  }
}
