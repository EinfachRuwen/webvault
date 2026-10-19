# Referenz-Tests gegen die offizielle Cryptomator-Bibliothek

Die Tresore in `tests/fixtures/` wurden **nicht** mit diesem Projekt, sondern mit der offiziellen
Java-Bibliothek [`cryptofs`](https://github.com/cryptomator/cryptofs) erzeugt (`Gen.java`).
Damit ist belegt, dass WebVault echte Cryptomator-Tresore (Format 8, `SIV_GCM` und `SIV_CTRMAC`) liest.

Umgekehrt kann `Read.java` einen von WebVault *beschriebenen* Tresor mit der Referenz einlesen:

```bash
# 1. Abhängigkeiten holen (Java 21 + Maven)
mvn -q dependency:copy-dependencies -DoutputDirectory=lib   # pom.xml: org.cryptomator:cryptofs:2.9.0
# 2. Fixtures neu erzeugen (optional)
javac -cp "lib/*" Gen.java && java -cp ".:lib/*" Gen out/vault-SIV_GCM SIV_GCM "correct horse battery staple"
# 3. Von WebVault beschriebenen Zustand erzeugen und mit der Referenz gegenlesen
WEBVAULT_KEEP=/tmp/interop npx vitest run tests/write.test.ts
javac -cp "lib/*" Read.java && java -cp ".:lib/*" Read /tmp/interop/interop-SIV_GCM "correct horse battery staple"
```

Das Passwort aller Fixture-Tresore lautet `correct horse battery staple`.
