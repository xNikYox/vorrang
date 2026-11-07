# Vorrang

Verteilt die Leistung unter Windows: Spiele (z. B. Minecraft) bekommen Vorrang, Browser & Co. werden gedrosselt.

- **CPU-Priorität:** Spiel hoch, Gedrosselte niedrig
- **CPU-Kerne:** Gedrosselte nur auf den hinteren Kernen
- **Grafikkarte:** Spiel auf die starke GPU, Gedrosselte auf die Stromspar-GPU
- **Upload-Limit:** QoS-Richtlinie je Programm (einmal Admin-Rechte)
- Spielmodus automatisch beim Spielstart, immer an oder aus; Energiesparplan „Höchstleistung“ optional
- Tray, Autostart, Auto-Update über GitHub-Releases; beim Beenden wird alles zurückgesetzt

Entwicklung: `npm test` · Release: Version in `package.json` erhöhen, Tag `vX.Y.Z` pushen → GitHub Actions testet auf Windows, baut den Installer und veröffentlicht ihn.
