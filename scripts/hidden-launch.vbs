Option Explicit
Dim shell, command, index, result
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 2
command = Chr(34) & WScript.Arguments(0) & Chr(34)
For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & Chr(34) & WScript.Arguments(index) & Chr(34)
Next
result = shell.Run(command, 0, True)
WScript.Quit result
