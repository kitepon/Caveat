# Set-Aclの原文抜粋

出典: [Microsoft Learn: Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-7.6)
取得日: 2026-09-10
確度: confirmed

Example 1から、ブラウザで取得したコードを抜粋。

```powershell
$DogACL = Get-Acl -Path "C:\Dog.txt"
Set-Acl -Path "C:\Cat.txt" -AclObject $DogACL
```
