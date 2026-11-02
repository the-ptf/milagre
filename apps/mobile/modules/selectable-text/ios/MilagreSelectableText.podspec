Pod::Spec.new do |s|
  s.name = 'MilagreSelectableText'
  s.version = '1.0.0'
  s.summary = 'In-place text selection for Milagre messages'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Milagre'
  s.homepage = 'https://milagre.cloud'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/the-ptf/milagre-ade.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
