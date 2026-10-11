package dz.phonestoremanager.app.mobile;

import java.io.ByteArrayOutputStream;

/**
 * ESC/POS for a thermal printer, as a picture. The whole receipt is drawn by the web app (so Arabic, French and every
 * font look the same as on screen) and sent as a monochrome raster, which every ESC/POS printer understands whatever
 * its code pages. Pure Java on purpose: it is unit-tested on the JVM, no Android classes in here.
 */
final class EscPos {
    private EscPos() {}

    /** Rows per GS v 0 block: small blocks keep cheap printers with tiny buffers from dropping data. */
    static final int BAND = 96;

    /** A pixel is ink when it is opaque and darker than this (0 to 255). */
    private static final int THRESHOLD = 160;

    /**
     * ESC @ (reset), the picture in bands, a few blank lines to tear off, and optionally a partial cut.
     *
     * @param argb   width * height pixels as Android ARGB ints
     * @param cut    send GS V 66 0 (partial cut) at the end; printers without a cutter ignore or mis-print it, so it is optional
     */
    static byte[] job(int[] argb, int width, int height, boolean cut) {
        if (width <= 0 || height <= 0 || argb.length < width * height) throw new IllegalArgumentException("bad picture");
        int bytesPerRow = (width + 7) / 8;
        ByteArrayOutputStream out = new ByteArrayOutputStream(bytesPerRow * height + 64);
        out.write(0x1B);
        out.write('@');
        for (int top = 0; top < height; top += BAND) {
            int rows = Math.min(BAND, height - top);
            out.write(0x1D);
            out.write('v');
            out.write('0');
            out.write(0); // normal density
            out.write(bytesPerRow & 0xFF);
            out.write((bytesPerRow >> 8) & 0xFF);
            out.write(rows & 0xFF);
            out.write((rows >> 8) & 0xFF);
            for (int y = top; y < top + rows; y++) {
                for (int bx = 0; bx < bytesPerRow; bx++) {
                    int b = 0;
                    for (int bit = 0; bit < 8; bit++) {
                        int x = bx * 8 + bit;
                        if (x < width && ink(argb[y * width + x])) b |= 0x80 >> bit;
                    }
                    out.write(b);
                }
            }
        }
        out.write(0x1B);
        out.write('d');
        out.write(cut ? 5 : 4); // feed lines
        if (cut) {
            out.write(0x1D);
            out.write('V');
            out.write(66);
            out.write(0);
        }
        return out.toByteArray();
    }

    private static boolean ink(int p) {
        int alpha = (p >>> 24) & 0xFF;
        if (alpha < 128) return false;
        int r = (p >> 16) & 0xFF;
        int g = (p >> 8) & 0xFF;
        int b = p & 0xFF;
        return (r * 299 + g * 587 + b * 114) / 1000 < THRESHOLD;
    }
}
