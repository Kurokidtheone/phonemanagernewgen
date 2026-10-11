package dz.phonestoremanager.app.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Arrays;
import org.junit.Test;

public class EscPosTest {
    private static final int BLACK = 0xFF000000;
    private static final int WHITE = 0xFFFFFFFF;
    private static final int CLEAR = 0x00000000;

    @Test
    public void packsEightPixelsPerByteMostSignificantBitFirst() {
        // 10 pixels wide: 2 bytes per row. Row 0: black at x = 0 and x = 9.
        int[] px = new int[10];
        Arrays.fill(px, WHITE);
        px[0] = BLACK;
        px[9] = BLACK;
        byte[] job = EscPos.job(px, 10, 1, false);
        // ESC @ | GS v 0 0 xL xH yL yH | 2 data bytes | ESC d 4
        assertArrayEquals(new byte[] {0x1B, '@', 0x1D, 'v', '0', 0, 2, 0, 1, 0, (byte) 0x80, 0x40, 0x1B, 'd', 4}, job);
    }

    @Test
    public void transparentAndLightPixelsStayBlank() {
        int[] px = {CLEAR, 0xFFC8C8C8, BLACK, 0xFF202020, WHITE, WHITE, WHITE, WHITE};
        byte[] job = EscPos.job(px, 8, 1, false);
        assertEquals((byte) 0b00110000, job[10]); // only the black and the dark grey
    }

    @Test
    public void tallPicturesAreSentInBands() {
        int height = EscPos.BAND * 2 + 5;
        int[] px = new int[8 * height];
        Arrays.fill(px, BLACK);
        byte[] job = EscPos.job(px, 8, height, false);
        // 2 + three blocks of (8 header + rows) + 3 feed bytes
        assertEquals(2 + 3 * 8 + height + 3, job.length);
        assertEquals(EscPos.BAND, job[2 + 6] & 0xFF); // first block's row count
        assertEquals(5, job[2 + 8 + EscPos.BAND * 2 + 8 + 6] & 0xFF); // the last, shorter block
    }

    @Test
    public void cutAddsFeedAndPartialCut() {
        byte[] job = EscPos.job(new int[] {BLACK}, 1, 1, true);
        byte[] tail = Arrays.copyOfRange(job, job.length - 7, job.length);
        assertArrayEquals(new byte[] {0x1B, 'd', 5, 0x1D, 'V', 66, 0}, tail);
    }

    @Test
    public void refusesAPictureThatDoesNotMatchItsSize() {
        assertThrows(IllegalArgumentException.class, () -> EscPos.job(new int[3], 4, 4, false));
        assertThrows(IllegalArgumentException.class, () -> EscPos.job(new int[0], 0, 0, false));
    }
}
