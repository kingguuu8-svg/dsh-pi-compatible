# Third-party notices

## Pi coding-agent behavior reference

Parts of the tool-contract design and independently adapted algorithms in this project are based on:

- Package: `@earendil-works/pi-coding-agent 0.84.2`
- Repository: <https://github.com/earendil-works/pi>
- License: MIT

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## fd and ripgrep

The runtime may download `fd` and `ripgrep` from their official GitHub releases when they are not installed locally and offline mode is disabled. The binaries are stored in the user's DSH home and are not redistributed in this npm package.

- fd: <https://github.com/sharkdp/fd>
- ripgrep: <https://github.com/BurntSushi/ripgrep>

Their upstream licenses apply to downloaded binaries.
