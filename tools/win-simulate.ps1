# Teltonika FMC cihaz simulatoru — Windows PowerShell (kurulum gerektirmez).
# Sunucuya (bu Mac) baglanip IMEI login + Codec 8 AVL paketi yollar, ack'leri dogrular.
#
# Kullanim (PowerShell'de):
#   .\win-simulate.ps1
#   .\win-simulate.ps1 -ServerIp 192.168.1.10 -Imei 350612345678901 -Lat 41.0082 -Lon 28.9784 -Speed 42
#
# Not: "running scripts is disabled" hatasi alirsan once sunu calistir:
#   powershell -ExecutionPolicy Bypass -File .\win-simulate.ps1 -ServerIp 192.168.1.10

param(
  [string]$ServerIp = "192.168.1.10",
  [int]$TcpPort = 5027,
  [string]$Imei = "350612345678901",
  [double]$Lat = 41.0082,
  [double]$Lon = 28.9784,
  [int]$Speed = 42
)

# --- big-endian yardimcilari ---
function BE64([long]$v){ [BitConverter]::GetBytes([System.Net.IPAddress]::HostToNetworkOrder([long]$v)) }
function BE32([int]$v){ [BitConverter]::GetBytes([System.Net.IPAddress]::HostToNetworkOrder([int]$v)) }
function BE16([int]$v){ [BitConverter]::GetBytes([System.Net.IPAddress]::HostToNetworkOrder([int16]$v)) }

# --- CRC-16/IBM (poly 0xA001) ---
function Get-Crc16([byte[]]$data){
  $crc = 0
  foreach($b in $data){
    $crc = $crc -bxor $b
    for($i=0;$i -lt 8;$i++){
      if($crc -band 1){ $crc = ($crc -shr 1) -bxor 0xA001 } else { $crc = $crc -shr 1 }
    }
  }
  return $crc -band 0xFFFF
}

# --- IMEI login paketi: [2B uzunluk][ASCII imei] ---
$imeiBytes = [System.Text.Encoding]::ASCII.GetBytes($Imei)
$loginPacket = [byte[]]((BE16 $imeiBytes.Length) + $imeiBytes)

# --- Codec 8 veri alani: 08 01 [ts prio gps] [io=0*6] 01 ---
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$data = New-Object System.Collections.Generic.List[byte]
$data.Add([byte]0x08)                                   # codec id (Codec 8)
$data.Add([byte]0x01)                                   # number of data 1
$data.AddRange([byte[]](BE64 $ts))                      # timestamp (ms)
$data.Add([byte]1)                                      # priority
$data.AddRange([byte[]](BE32 ([int][math]::Round($Lon * 1e7))))  # longitude
$data.AddRange([byte[]](BE32 ([int][math]::Round($Lat * 1e7))))  # latitude
$data.AddRange([byte[]](BE16 100))                      # altitude
$data.AddRange([byte[]](BE16 0))                        # angle
$data.Add([byte]12)                                     # satellites
$data.AddRange([byte[]](BE16 $Speed))                   # speed
$data.AddRange([byte[]](,0x00 * 6))                     # io: event,total,N1,N2,N4,N8 = 0
$data.Add([byte]0x01)                                   # number of data 2
$dataArr = $data.ToArray()

$crc = Get-Crc16 $dataArr
$avlPacket = [byte[]]((BE32 0) + (BE32 $dataArr.Length) + $dataArr + (BE32 $crc))

# --- TCP gonderim ---
Write-Host "-> $ServerIp`:$TcpPort baglaniliyor, IMEI $Imei"
$client = New-Object System.Net.Sockets.TcpClient
try {
  $client.Connect($ServerIp, $TcpPort)
  $ns = $client.GetStream()

  $ns.Write($loginPacket, 0, $loginPacket.Length)
  $ack = New-Object byte[] 1
  $null = $ns.Read($ack, 0, 1)
  if($ack[0] -ne 1){ Write-Host "x login reddedildi (0x$('{0:X2}' -f $ack[0]))"; return }
  Write-Host "+ login kabul (0x01), AVL paketi gonderiliyor"

  $ns.Write($avlPacket, 0, $avlPacket.Length)
  $resp = New-Object byte[] 4
  $null = $ns.Read($resp, 0, 4)
  $accepted = [System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($resp, 0))
  Write-Host "+ sunucu $accepted kayit kabul etti. Haritada: http://$ServerIp`:3111"
}
catch { Write-Host "x hata: $($_.Exception.Message)" }
finally { $client.Close() }
