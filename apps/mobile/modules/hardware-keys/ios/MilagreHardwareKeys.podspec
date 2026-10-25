Pod::Spec.new do |s|
  s.name = 'MilagreHardwareKeys'
  s.version = '1.0.0'
  s.summary = 'Hardware keyboard Return and shortcuts for Milagre on iPad'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Milagre'
  s.homepage = 'https://milagre.cloud'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/the-ptf/milagre-ade.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'React-RCTText'
  s.dependency 'React-Core'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
