# homebridge-gecko-direct

Local HomeKit control of Gecko in.touch2 hot tubs. Homebridge talks to the spa's in.touch2 home module over your own network (UDP port 10022). It needs no Gecko account, no cloud service and no bridge app.

This plugin is not affiliated with or endorsed by Gecko Alliance. "Gecko" and "in.touch" are their trademarks.

## What you get in the Home app

| Accessory | HomeKit type | What it does |
|---|---|---|
| Spa | Thermostat | Water temperature, setpoint, heating on or idle |
| Spa Pump 1, Spa Pump 2 | Fan | Off, 50% = low, 100% = high. A filter cycle shows as low. |
| Spa Lights | Light | On and off |
| Spa Blower | Switch | Optional, if your spa has one |
| Spa Watercare | 5 switches | Away From Home, Standard, Energy Saving, Super Energy Saving, Weekender. Turning one on turns the others off. |

## Requirements

- Homebridge 1.8 or later, including 2.x
- Node.js 18, 20, 22 or 24
- A Gecko in.touch2 home module (the Wi-Fi or Ethernet module that the in.touch2 app uses)
- Homebridge and the spa on the same network and subnet. Give the spa a fixed IP address in your router.
- Supported spa packs: inXE, inYT, inYE, inYJ. The Homebridge log shows the pack it finds.

Newer spas with an in.touch 3 gateway are not supported. For those, see [homebridge-gecko](https://www.npmjs.com/package/homebridge-gecko), which works through Gecko's cloud.

## Install

1. In the Homebridge UI, open **Plugins** and search for `homebridge-gecko-direct`.
2. Click **Install**.
3. In the settings window, enter your spa's IP address and save.
4. Restart Homebridge. The accessories appear in the Home app.

If you run Homebridge in Docker, the container must use host networking so it can reach the spa.

## Configuration

The settings window covers every option. If you edit `config.json` directly, add this to the `platforms` list:

```json
{
  "platform": "GeckoSpaDirect",
  "name": "Spa",
  "spaIp": "192.168.1.50",
  "pumps": 2,
  "blower": false,
  "watercareSwitches": true,
  "units": "C",
  "minSetpoint": 20,
  "maxSetpoint": 40,
  "debug": false
}
```

| Option | Default | Meaning |
|---|---|---|
| `name` | `Spa` | Prefix for every accessory name |
| `spaIp` | none, required | The spa's IP address. The plugin stays idle until this is set. |
| `pumps` | `2` | Number of jet pumps to show (0 to 2) |
| `blower` | `false` | Show a switch for the air blower |
| `watercareSwitches` | `true` | Show the five watercare mode switches |
| `units` | `C` | Thermostat display units, `C` or `F` |
| `minSetpoint`, `maxSetpoint` | `20`, `40` | Setpoint range in Celsius |
| `debug` | `false` | Log protocol traffic |

## Running alongside other controllers

The plugin runs alongside the Gecko in.touch2 app and other local controllers. A change made in one shows up in the others within seconds. Watercare is the exception: the spa does not push it, so the plugin checks it every 60 seconds.

## Troubleshooting

- **`Nothing received from <ip>:10022`**: the IP is wrong, or Homebridge is on another subnet or VLAN.
- **`Unsupported spa pack`**: open an issue and include the pack name from that log line.
- **Accessories show No Response**: the spa stopped answering. The plugin reconnects on its own when the spa comes back.

When you open an issue, turn on **Debug logging**, restart Homebridge, and attach the log lines that mention the spa.

## Credits

The protocol and status-block layout come from [geckolib](https://github.com/gazoodle/geckolib) by Gazoodle (GPL-3.0). This plugin uses the same licence.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
