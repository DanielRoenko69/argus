// Hidden behavioral oracle for rclone/rclone issue #8675.
//
// Source repository: https://github.com/rclone/rclone (MIT)
// Historical issue: https://github.com/rclone/rclone/issues/8675
//
// The fixture setup and initial resyncs are deliberately serial. Only the
// production RC jobs run concurrently, so race reports describe the bisync RC
// execution path rather than mutable globals in rclone's integration harness.
package bisync_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/cmd/bisync/bilib"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/rc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestArgusBisyncConcurrent(t *testing.T) {
	ctx := context.Background()

	type syncPair struct {
		name  string
		path1 string
		path2 string
		work  string
	}

	makePair := func(name string) syncPair {
		root := t.TempDir()
		path1 := filepath.Join(root, "path1")
		path2 := filepath.Join(root, "path2")
		work := filepath.Join(root, "work")
		require.NoError(t, os.MkdirAll(path1, 0o700))
		require.NoError(t, os.MkdirAll(path2, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(path1, "initial"), []byte(name), bilib.PermSecure))

		fs1, err := fs.NewFs(ctx, path1)
		require.NoError(t, err)
		fs2, err := fs.NewFs(ctx, path2)
		require.NoError(t, err)
		resyncCtx, _ := fs.AddConfig(ctx)
		require.NoError(t, bisync.Bisync(resyncCtx, fs1, fs2, &bisync.Options{
			Resync:    true,
			Workdir:   work,
			MaxDelete: bisync.DefaultMaxDelete,
			CheckSync: bisync.CheckSyncTrue,
			MaxLock:   fs.Duration(2 * time.Minute),
		}))

		require.NoError(t, os.WriteFile(filepath.Join(path1, "updated"), []byte("updated-"+name), bilib.PermSecure))
		require.NoError(t, os.WriteFile(filepath.Join(path1, "conflict"), []byte("path1-"+name), bilib.PermSecure))
		require.NoError(t, os.WriteFile(filepath.Join(path2, "conflict"), []byte("path2-"+name), bilib.PermSecure))
		payload := bytes.Repeat([]byte(name), 32*1024)
		for index := 0; index < 64; index++ {
			require.NoError(t, os.WriteFile(
				filepath.Join(path1, "batch-"+time.Unix(int64(index), 0).Format("150405")+".bin"),
				payload,
				bilib.PermSecure,
			))
		}
		return syncPair{name: name, path1: path1, path2: path2, work: work}
	}

	pairs := []syncPair{makePair("one"), makePair("two")}
	call := rc.Calls.Get("sync/bisync")
	require.NotNil(t, call)
	start := make(chan struct{})
	type callResult struct {
		output rc.Params
		err    error
	}
	results := make(chan callResult, len(pairs))

	for _, pair := range pairs {
		params := rc.Params{
			"path1":     pair.path1,
			"path2":     pair.path2,
			"workdir":   pair.work,
			"maxDelete": int64(bisync.DefaultMaxDelete),
			"checkSync": "true",
		}
		jobCtx, _ := fs.AddConfig(ctx)
		config := fs.GetConfig(jobCtx)
		config.Checkers = 1
		config.Transfers = 1
		go func() {
			<-start
			output, err := call.Fn(jobCtx, params)
			results <- callResult{output: output, err: err}
		}()
	}
	close(start)

	for range pairs {
		select {
		case result := <-results:
			require.NoError(t, result.err)
			output, err := result.output.GetString("output")
			require.NoError(t, err)
			assert.Contains(t, output, "Bisync successful")
		case <-time.After(30 * time.Second):
			t.Fatal("timed out waiting for concurrent bisync jobs to finish")
		}
	}

	for _, pair := range pairs {
		got1, err := os.ReadFile(filepath.Join(pair.path1, "updated"))
		require.NoError(t, err)
		got2, err := os.ReadFile(filepath.Join(pair.path2, "updated"))
		require.NoError(t, err)
		assert.Equal(t, got1, got2)

		for _, path := range []string{pair.path1, pair.path2} {
			conflict1, err := os.ReadFile(filepath.Join(path, "conflict.conflict1"))
			require.NoError(t, err)
			assert.Equal(t, "path1-"+pair.name, string(conflict1))
			conflict2, err := os.ReadFile(filepath.Join(path, "conflict.conflict2"))
			require.NoError(t, err)
			assert.Equal(t, "path2-"+pair.name, string(conflict2))
		}
	}
}
