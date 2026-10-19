import org.cryptomator.cryptofs.*;
import org.cryptomator.cryptolib.api.*;
import org.cryptomator.cryptolib.common.MasterkeyFileAccess;
import java.net.URI;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.stream.*;

/** Liest einen Tresor mit der offiziellen Cryptomator-Bibliothek und gibt "pfad<TAB>größe<TAB>sha256" je Datei aus. */
public class Read {
  public static void main(String[] a) throws Exception {
    Path vault = Paths.get(a[0]);
    String pw = a[1];
    SecureRandom rnd = new SecureRandom();
    MasterkeyFileAccess mfa = new MasterkeyFileAccess(new byte[0], rnd);
    MasterkeyLoader loader = uri -> mfa.load(vault.resolve("masterkey.cryptomator"), pw);
    CryptoFileSystemProperties props = CryptoFileSystemProperties.cryptoFileSystemProperties().withKeyLoader(loader).build();
    try (FileSystem fs = CryptoFileSystemProvider.newFileSystem(vault, props)) {
      List<String> lines = new ArrayList<>();
      try (Stream<Path> s = Files.walk(fs.getPath("/"))) {
        for (Path p : (Iterable<Path>) s::iterator) {
          if (!Files.isRegularFile(p)) continue;
          byte[] data = Files.readAllBytes(p);
          StringBuilder h = new StringBuilder();
          for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) h.append(String.format("%02x", b));
          lines.add(p + "\t" + data.length + "\t" + h);
        }
      }
      Collections.sort(lines);
      java.io.PrintStream out = new java.io.PrintStream(System.out, true, "UTF-8");
      lines.forEach(out::println);
    }
  }
}
