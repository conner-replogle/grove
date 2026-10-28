// Grove.exe: starts an installed Grove on Windows (a bundle from
// scripts/bundle.mjs), as packaging/linux/grove does on Linux:
//
//	<bundle>\Grove.exe   this
//	<bundle>\chromium\   the pinned Chromium
//	<bundle>\node\       the pinned Node
//	<bundle>\app\        Grove itself, as shipped with this bundle
//
// Grove runs from a copy of app\ in %LOCALAPPDATA%\Grove, so it can update
// itself (host/updates.ts) without touching the bundle; a newer bundle's
// app\ replaces that copy. The launcher runs in Node with no console
// window, logging to %LOCALAPPDATA%\Grove\grove.log.
//
// Built for the Windows GUI subsystem (no console of its own) by
// scripts/bundle.mjs.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// CREATE_NO_WINDOW: Node is a console program; it gets no console window.
const createNoWindow = 0x08000000

func main() {
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	data := filepath.Join(os.Getenv("LOCALAPPDATA"), "Grove")
	if err := os.MkdirAll(data, 0o755); err != nil {
		fail(err)
	}
	args := os.Args[1:]

	// Grove.exe --swap <bundle> [args]: a copy of Grove.exe outside the
	// bundle swaps a full update in (below).
	if len(args) >= 2 && args[0] == "--swap" {
		swap(args[1], args[2:])
		return
	}

	bundle := filepath.Dir(self)
	// A full update (host/updates.ts) leaves the new bundle beside this one
	// as <bundle>.new. Windows won't rename a folder a running program is in,
	// so a copy of this program, outside it, swaps them once the old Grove
	// has gone, and starts the new one. Not while Grove runs (this launch
	// just hands a link to it), nor right after a swap that couldn't.
	if exists(filepath.Join(bundle+".new", "bundle.json")) && os.Getenv("GROVE_NO_SWAP") == "" && !running(data) {
		swapper := filepath.Join(data, fmt.Sprintf("Grove-swap-%d.exe", os.Getpid()))
		if err := copyFile(self, swapper); err == nil {
			if start(swapper, append([]string{"--swap", bundle}, args...), data, nil) == nil {
				return
			}
		}
	}
	// What earlier swaps left behind.
	if old, _ := filepath.Glob(filepath.Join(data, "Grove-swap-*.exe")); old != nil {
		for _, f := range old {
			os.Remove(f)
		}
	}

	app := filepath.Join(data, "app")
	if !exists(filepath.Join(app, "launcher", "grove.mjs")) || newer(version(filepath.Join(bundle, "app")), version(app)) {
		if err := installApp(filepath.Join(bundle, "app"), app); err != nil && !exists(filepath.Join(app, "launcher", "grove.mjs")) {
			fail(err)
		}
	}

	env := os.Environ()
	if os.Getenv("GROVE_CHROME") == "" {
		env = append(env, "GROVE_CHROME="+filepath.Join(bundle, "chromium", "chrome.exe"))
	}
	env = append(env, "GROVE_BUNDLE="+bundle, "GROVE_RELAUNCH="+self, "GROVE_NO_SWAP=")

	logPath := filepath.Join(data, "grove.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > 8<<20 {
		os.Rename(logPath, logPath+".old")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fail(err)
	}
	node := filepath.Join(bundle, "node", "node.exe")
	cmd := exec.Command(node, append([]string{filepath.Join(app, "launcher", "grove.mjs")}, args...)...)
	cmd.Dir = data
	cmd.Env = env
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if err := cmd.Start(); err != nil {
		fail(err)
	}
}

// Swaps <bundle>.new in for <bundle> once nothing runs from the old one
// (until then Windows refuses the rename), then starts the new Grove.
func swap(bundle string, args []string) {
	var err error
	for i := 0; i < 60; i++ {
		if err = os.Rename(bundle, bundle+".old"); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err == nil {
		if err = os.Rename(bundle+".new", bundle); err != nil {
			os.Rename(bundle+".old", bundle)
		} else {
			os.RemoveAll(bundle + ".old")
		}
	}
	// Whichever bundle is in place now.
	env := os.Environ()
	if err != nil {
		env = append(env, "GROVE_NO_SWAP=1")
	}
	if err := start(filepath.Join(bundle, "Grove.exe"), args, filepath.Dir(bundle), env); err != nil {
		fail(err)
	}
}

// Copies the bundle's app over the user's copy, as app.new then two renames.
func installApp(from, to string) error {
	staged := to + ".new"
	os.RemoveAll(staged)
	if err := copyDir(from, staged); err != nil {
		os.RemoveAll(staged)
		return err
	}
	os.WriteFile(filepath.Join(staged, ".installed"), []byte("bundle "+version(from)+"\n"), 0o644)
	os.RemoveAll(to + ".old")
	if exists(to) {
		if err := os.Rename(to, to+".old"); err != nil {
			os.RemoveAll(staged)
			return err
		}
	}
	return os.Rename(staged, to)
}

func start(exe string, args []string, dir string, env []string) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	cmd.Env = env
	return cmd.Start()
}

// Whether Grove runs on its default profile: Chrome holds the profile's
// lockfile open, unshared, so it can't be deleted.
func running(data string) bool {
	err := os.Remove(filepath.Join(data, "User Data", "lockfile"))
	return err != nil && !os.IsNotExist(err)
}

func version(app string) string {
	var p struct{ Version string }
	b, err := os.ReadFile(filepath.Join(app, "package.json"))
	if err != nil || json.Unmarshal(b, &p) != nil || p.Version == "" {
		return "0.0.0"
	}
	return p.Version
}

// "1.2.10" > "1.2.9"; anything after "-" or "+" is ignored.
func newer(a, b string) bool {
	parts := func(v string) []int {
		v = strings.FieldsFunc(v, func(r rune) bool { return r == '-' || r == '+' })[0]
		var n []int
		for _, p := range strings.Split(v, ".") {
			i, _ := strconv.Atoi(p)
			n = append(n, i)
		}
		return append(n, 0, 0, 0)
	}
	x, y := parts(a), parts(b)
	for i := 0; i < 3; i++ {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func copyDir(from, to string) error {
	return filepath.Walk(from, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		dest := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		return copyFile(path, dest)
	})
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// A GUI program has no console to print to: say it in a message box.
func fail(err error) {
	user32 := syscall.NewLazyDLL("user32.dll")
	text, _ := syscall.UTF16PtrFromString("Grove couldn't start:\n\n" + err.Error())
	title, _ := syscall.UTF16PtrFromString("Grove")
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
	os.Exit(1)
}
