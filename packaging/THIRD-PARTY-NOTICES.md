# Third-party notices

Shelfs is distributed under the GNU General Public License, version 3 or later
(see `LICENSE`). It is built on the following components, which keep their own
licences:

| Component | Version | Licence |
| --- | --- | --- |
| Tauri (`tauri`, `tauri-build`, plugins) | 2.x | MIT OR Apache-2.0 |
| Wry / WebKitGTK bindings | 0.5x | MIT OR Apache-2.0 |
| Rusqlite (bundled SQLite) | 0.3x | MIT; SQLite itself is public domain |
| three.js | 0.186 | MIT |
| pdf.js (`pdfjs-dist`) | 6.4 | Apache-2.0 |
| RSS / XML helpers (quick-xml, serde, zip, …) | — | MIT OR Apache-2.0 |
| Literata, Source Serif 4, Gelasio, Inter, OpenDyslexic | — | SIL OFL 1.1 |

Rust dependencies and their exact versions are listed in `src-tauri/Cargo.lock`;
JavaScript dependencies are in `package-lock.json`. Each crate and package ships
its own licence text, reproduced verbatim in this tree by `cargo metadata` /
`npm ls` when a source distribution is prepared.

## MIT (Tauri, three.js, rusqlite)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Apache-2.0 (pdf.js)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
these files except in compliance with the License. You may obtain a copy of the
License at <https://www.apache.org/licenses/LICENSE-2.0>. Unless required by
applicable law or agreed to in writing, software distributed under the License is
distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied. See the License for the specific language governing
permissions and limitations under the License.

## SIL Open Font License 1.1 (bundled fonts)

The full text is at `ui/public/fonts/OFL.txt` and is served with the app at
`/fonts/OFL.txt`.
