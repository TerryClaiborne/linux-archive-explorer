<?php
declare(strict_types=1);
/**
 * Append one authenticated browser-upload chunk without ever allowing the
 * persisted part file to exceed the advertised total or per-chunk limit.
 * A part-file lock protects offset checks, writes, and metadata publication.
 */
function lae_append_guarded_chunk(string $part, string $metadataPath, int $offset, int $chunkMax, string $kind): array
{
    if (!is_file($part) || is_link($part) || !is_file($metadataPath) || is_link($metadataPath)) {
        throw new RuntimeException("{$kind} staging files are unavailable.");
    }
    $out = @fopen($part, 'c+b');
    if ($out === false) {
        throw new RuntimeException("Unable to open {$kind} staging file.");
    }
    $in = null;
    $original = null;
    $committed = false;
    try {
        if (!flock($out, LOCK_EX)) {
            throw new RuntimeException("Unable to lock {$kind}.");
        }
        $stat = fstat($out);
        if ($stat === false) {
            throw new RuntimeException("Unable to inspect {$kind} staging file.");
        }
        $original = (int)$stat['size'];
        $meta = json_decode((string)@file_get_contents($metadataPath), true);
        if (!is_array($meta) || !empty($meta['complete'])) {
            throw new RuntimeException("{$kind} is not active.");
        }
        $total = $meta['size'] ?? null;
        if (!is_int($total) || $total < 0 || $original > $total) {
            throw new RuntimeException("{$kind} metadata or staging size is invalid.");
        }
        if ($offset !== $original || (int)($meta['received'] ?? -1) !== $original) {
            throw new RuntimeException("{$kind} offset mismatch.");
        }
        $remaining = $total - $original;
        $declaredLength = $_SERVER['CONTENT_LENGTH'] ?? null;
        if ($declaredLength !== null && $declaredLength !== '') {
            if (!ctype_digit((string)$declaredLength)) {
                throw new RuntimeException("Invalid {$kind} content length.");
            }
            $n = (int)$declaredLength;
            if ($n > $remaining || $n > $chunkMax) {
                throw new RuntimeException("{$kind} chunk exceeds the allowed size.");
            }
        }
        $in = @fopen('php://input', 'rb');
        if ($in === false || fseek($out, 0, SEEK_END) !== 0) {
            throw new RuntimeException("Unable to write {$kind} chunk.");
        }
        $written = 0;
        while (!feof($in)) {
            $buf = fread($in, 1024 * 1024);
            if ($buf === false) {
                throw new RuntimeException("{$kind} read failed.");
            }
            $len = strlen($buf);
            if ($len === 0) {
                if (!feof($in)) {
                    throw new RuntimeException("{$kind} stream stalled.");
                }
                break;
            }
            if ($len > $chunkMax - $written || $len > $remaining - $written) {
                throw new RuntimeException("{$kind} chunk exceeds the allowed size.");
            }
            $position = 0;
            while ($position < $len) {
                $n = fwrite($out, substr($buf, $position));
                if ($n === false || $n === 0) {
                    throw new RuntimeException("{$kind} write failed.");
                }
                $position += $n;
            }
            $written += $len;
        }
        if (!fflush($out)) {
            throw new RuntimeException("{$kind} flush failed.");
        }
        $meta['received'] = $original + $written;
        $encoded = json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        // Publish metadata atomically: a short/error write must not corrupt the
        // session's JSON. The part lock serializes all chunk writers.
        $temporary = $metadataPath . '.' . bin2hex(random_bytes(8)) . '.tmp';
        try {
            if (@file_put_contents($temporary, $encoded, LOCK_EX) !== strlen($encoded)
                || !@chmod($temporary, 0640)
                || !@rename($temporary, $metadataPath)) {
                throw new RuntimeException("Unable to update {$kind} metadata.");
            }
        } finally {
            if (is_file($temporary)) {
                @unlink($temporary);
            }
        }
        $committed = true;
        return ['ok' => true, 'received' => $meta['received'], 'size' => $total];
    } finally {
        if ($in !== null && is_resource($in)) {
            fclose($in);
        }
        if (!$committed && $original !== null) {
            // Restore the exact pre-request length before releasing the lock.
            @ftruncate($out, $original);
            @fflush($out);
        }
        @flock($out, LOCK_UN);
        fclose($out);
    }
}
